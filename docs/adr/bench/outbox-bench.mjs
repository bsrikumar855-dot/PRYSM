// Postgres transactional-outbox latency benchmark for ADR-0009. No dependencies (Node >= 22).
// Uses the simple query protocol with trust auth, so only run it against a throwaway local container:
//
//   docker run -d --rm --name pg-bench -e POSTGRES_HOST_AUTH_METHOD=trust -p 5433:5432 postgres:16
//   node docs/adr/bench/outbox-bench.mjs 127.0.0.1 5433
//   node docs/adr/bench/outbox-bench.mjs --selftest
import net from 'node:net';

/** Splits complete backend messages off the buffer. Returns [messages, rest]. */
export function splitMessages(buf) {
  const msgs = [];
  let off = 0;
  while (buf.length - off >= 5) {
    const len = buf.readInt32BE(off + 1);
    if (buf.length - off < 1 + len) break;
    msgs.push({ type: String.fromCharCode(buf[off]), body: buf.subarray(off + 5, off + 1 + len) });
    off += 1 + len;
  }
  return [msgs, buf.subarray(off)];
}

function dataRow(body) {
  const n = body.readInt16BE(0);
  const cols = [];
  let off = 2;
  for (let i = 0; i < n; i++) {
    const len = body.readInt32BE(off);
    off += 4;
    cols.push(len === -1 ? null : body.toString('utf8', off, off + len));
    if (len > 0) off += len;
  }
  return cols;
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    sock.on('error', reject);
    let buf = Buffer.alloc(0);
    let pending = { res: () => resolve(query), rej: reject, rows: [], err: null };
    const queue = [];
    sock.on('connect', () => {
      const params = Buffer.from('user\0postgres\0database\0postgres\0\0');
      const head = Buffer.alloc(8);
      head.writeInt32BE(8 + params.length, 0);
      head.writeInt32BE(196608, 4);
      sock.write(Buffer.concat([head, params]));
    });
    sock.on('data', (chunk) => {
      let msgs;
      [msgs, buf] = splitMessages(Buffer.concat([buf, chunk]));
      for (const m of msgs) {
        if (m.type === 'R' && m.body.readInt32BE(0) !== 0) pending.err = new Error('auth required; use trust auth');
        else if (m.type === 'E') pending.err = new Error(m.body.toString('utf8').replace(/\0/g, ' '));
        else if (m.type === 'D') pending.rows.push(dataRow(m.body));
        else if (m.type === 'Z') {
          const p = pending;
          p.err ? p.rej(p.err) : p.res(p.rows);
          pending = queue.shift();
        }
      }
    });
    function query(sql) {
      if (sql === 'CLOSE') return sock.end();
      return new Promise((res, rej) => {
        const entry = { res, rej, rows: [], err: null };
        if (pending) queue.push(entry);
        else pending = entry;
        const body = Buffer.from(sql + '\0');
        const head = Buffer.alloc(5);
        head.write('Q', 0);
        head.writeInt32BE(4 + body.length, 1);
        sock.write(Buffer.concat([head, body]));
      });
    }
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function summary(name, samples, wallMs) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    scenario: name,
    n: s.length,
    p50_ms: +pct(s, 50).toFixed(2),
    p95_ms: +pct(s, 95).toFixed(2),
    p99_ms: +pct(s, 99).toFixed(2),
    max_ms: +s[s.length - 1].toFixed(2),
    ops_per_s: Math.round((s.length / wallMs) * 1000),
  };
}

const PAYLOAD = JSON.stringify({ tenant: 't1', payload: 'x'.repeat(512) });

async function scenario(host, port, name, n, concurrency, syncCommit) {
  const clients = await Promise.all(Array.from({ length: concurrency }, () => connect(host, port)));
  await Promise.all(clients.map((c) => c(`SET synchronous_commit = ${syncCommit}`)));
  const samples = [];
  let remaining = n;
  const t0 = performance.now();
  await Promise.all(
    clients.map(async (c) => {
      while (remaining-- > 0) {
        const s = performance.now();
        await c(
          `INSERT INTO strict_outbox (tenant_id, event_id, payload) VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), '${PAYLOAD}')`,
        );
        samples.push(performance.now() - s);
      }
    }),
  );
  const wall = performance.now() - t0;
  clients.forEach((c) => c('CLOSE'));
  return summary(name, samples, wall);
}

async function main() {
  if (process.argv[2] === '--selftest') {
    const z = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
    const d = Buffer.concat([Buffer.from([0x44, 0, 0, 0, 11, 0, 1, 0, 0, 0, 1]), Buffer.from('a')]);
    const [msgs, rest] = splitMessages(Buffer.concat([d, z, Buffer.from([0x5a, 0, 0])]));
    if (msgs.length !== 2 || msgs[1].type !== 'Z' || rest.length !== 3) throw new Error('split failed');
    if (dataRow(msgs[0].body)[0] !== 'a') throw new Error('dataRow failed');
    console.log('selftest ok');
    return;
  }
  const [host = '127.0.0.1', port = '5432', n = '2000'] = process.argv.slice(2);
  const c = await connect(host, Number(port));
  await c('DROP TABLE IF EXISTS strict_outbox');
  await c(`CREATE TABLE strict_outbox (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id uuid NOT NULL,
    event_id uuid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL)`);
  const settings = {};
  for (const k of ['server_version', 'fsync', 'wal_sync_method', 'synchronous_commit']) {
    settings[k] = (await c(`SHOW ${k}`))[0][0];
  }
  c('CLOSE');
  const N = Number(n);
  const results = [
    await scenario(host, port, 'INSERT outbox, synchronous_commit=on, 1 conn', N, 1, 'on'),
    await scenario(host, port, 'INSERT outbox, synchronous_commit=on, 50 conns', N * 5, 50, 'on'),
    await scenario(host, port, 'INSERT outbox, synchronous_commit=off, 50 conns (reference, not durable)', N * 5, 50, 'off'),
  ];
  console.log(JSON.stringify({ settings, results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
