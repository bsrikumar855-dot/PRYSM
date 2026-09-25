// M0 verification: every service is ready, a request produces a trace in Tempo, and its log line reaches
// Loki with the request id but never the payload. Run after `pnpm infra:up && pnpm dev` or `pnpm stack:up`.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVICES = [
  ['api', 'http://127.0.0.1:4000'],
  ['gateway', 'http://127.0.0.1:4100'],
  ['workers', 'http://127.0.0.1:4200'],
  ['web', 'http://127.0.0.1:3001'],
  ['ai-service', 'http://127.0.0.1:8000'],
];
const TEMPO = 'http://127.0.0.1:3200';
const LOKI = 'http://127.0.0.1:3100';

let failures = 0;
const pass = (msg) => console.log(`PASS  ${msg}`);
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failures++;
};

/** Retries `fn` until it returns a truthy value or `timeoutMs` passes. */
async function eventually(fn, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // not there yet
    }
    await sleep(intervalMs);
  }
  return last;
}

for (const [name, base] of SERVICES) {
  const ready = await eventually(async () => {
    const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(3_000) });
    return res.status === 200 && (await res.json()).status === 'ready';
  }, 60_000);
  ready ? pass(`${name} /readyz is ready`) : fail(`${name} /readyz not ready at ${base}`);
}

const traceId = randomBytes(16).toString('hex');
const requestId = `verify-m0-${randomUUID()}`;
const canary = `CANARY-${randomBytes(6).toString('hex')}`;
const res = await fetch(`http://127.0.0.1:4000/readyz?token=${canary}`, {
  headers: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`, 'x-request-id': requestId },
});
res.headers.get('x-request-id') === requestId ? pass('api echoes x-request-id') : fail('api did not echo x-request-id');

const trace = await eventually(async () => {
  const r = await fetch(`${TEMPO}/api/traces/${traceId}`);
  if (r.status !== 200) return undefined;
  const body = await r.text();
  return body.includes('prysm-api') ? body : undefined;
}, 60_000, 2_000);
trace ? pass(`trace ${traceId} from prysm-api is in Tempo`) : fail(`trace ${traceId} not found in Tempo`);

const query = encodeURIComponent(`{service_name="prysm-api"} | request_id = "${requestId}"`);
const logs = await eventually(async () => {
  const r = await fetch(`${LOKI}/loki/api/v1/query_range?query=${query}&since=10m&limit=50`);
  const body = await r.json();
  const lines = (body.data?.result ?? []).flatMap((s) => [JSON.stringify(s.stream), ...s.values.map((v) => v[1])]);
  return lines.length > 0 ? lines.join('\n') : undefined;
}, 60_000, 2_000);
if (!logs) fail(`no log line with request_id ${requestId} in Loki`);
else {
  pass('request log line with request_id is in Loki');
  logs.includes(canary) ? fail('payload canary from the query string leaked into logs') : pass('no payload canary in logs');
}

console.log(failures === 0 ? '\nM0 verification passed' : `\nM0 verification FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
