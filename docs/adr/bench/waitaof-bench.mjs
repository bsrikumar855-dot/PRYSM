// WAITAOF latency benchmark for ADR-0004 / ADR-0009. No dependencies (Node >= 22).
//
//   docker run -d --rm --name vk-everysec -p 6391:6379 valkey/valkey:8 valkey-server --appendonly yes --appendfsync everysec
//   docker run -d --rm --name vk-always   -p 6392:6379 valkey/valkey:8 valkey-server --appendonly yes --appendfsync always
//   node docs/adr/bench/waitaof-bench.mjs 127.0.0.1 6391
//   node docs/adr/bench/waitaof-bench.mjs 127.0.0.1 6392
//   node docs/adr/bench/waitaof-bench.mjs --selftest
import net from 'node:net';

/** Incremental RESP2 parser. Returns [value, nextOffset] or null if the buffer is incomplete. */
export function parseResp(buf, off = 0) {
  if (off >= buf.length) return null;
  const nl = buf.indexOf('\r\n', off);
  if (nl === -1) return null;
  const type = String.fromCharCode(buf[off]);
  const line = buf.toString('utf8', off + 1, nl);
  const next = nl + 2;
  if (type === '+') return [line, next];
  if (type === '-') return [new Error(line), next];
  if (type === ':') return [Number(line), next];
  if (type === '$') {
    const len = Number(line);
    if (len === -1) return [null, next];
    if (buf.length < next + len + 2) return null;
    return [buf.toString('utf8', next, next + len), next + len + 2];
  }
  if (type === '*') {
    const n = Number(line);
    if (n === -1) return [null, next];
    const out = [];
    let pos = next;
    for (let i = 0; i < n; i++) {
      const r = parseResp(buf, pos);
      if (!r) return null;
      out.push(r[0]);
      pos = r[1];
    }
    return [out, pos];
  }
  throw new Error(`unknown RESP type ${type}`);
}

function encode(args) {
  return `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('');
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => resolve(call));
    sock.setNoDelay(true);
    sock.on('error', reject);
    let buf = Buffer.alloc(0);
    const waiting = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let r;
      while ((r = parseResp(buf)) !== null) {
        buf = buf.subarray(r[1]);
        const { res, rej } = waiting.shift();
        r[0] instanceof Error ? rej(r[0]) : res(r[0]);
      }
    });
    function call(...args) {
      if (args[0] === 'CLOSE') return sock.end();
      return new Promise((res, rej) => {
        waiting.push({ res, rej });
        sock.write(encode(args));
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

async function scenario(host, port, name, n, concurrency, withWait) {
  const clients = await Promise.all(Array.from({ length: concurrency }, () => connect(host, port)));
  const samples = [];
  let remaining = n;
  const t0 = performance.now();
  await Promise.all(
    clients.map(async (c) => {
      while (remaining-- > 0) {
        const s = performance.now();
        await c('XADD', 'bench:events', '*', 'tenant', 't1', 'payload', 'x'.repeat(512));
        if (withWait) {
          const [local] = await c('WAITAOF', '1', '0', '5000');
          if (local !== 1) throw new Error('WAITAOF timed out');
        }
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
    const b = Buffer.from('*2\r\n:1\r\n:0\r\n$5\r\nhello\r\n-ERR x\r\n');
    const [a, o1] = parseResp(b);
    const [s, o2] = parseResp(b, o1);
    const [e] = parseResp(b, o2);
    if (JSON.stringify(a) !== '[1,0]' || s !== 'hello' || !(e instanceof Error)) throw new Error('selftest failed');
    if (parseResp(Buffer.from('$5\r\nhel')) !== null) throw new Error('partial bulk must return null');
    console.log('selftest ok');
    return;
  }
  const [host = '127.0.0.1', port = '6379', n = '400'] = process.argv.slice(2);
  const c = await connect(host, Number(port));
  const [, fsync] = await c('CONFIG', 'GET', 'appendfsync');
  const info = await c('INFO', 'server');
  const version = /(?:valkey|redis)_version:(\S+)/.exec(info)?.[0];
  await c('DEL', 'bench:events');
  c('CLOSE');
  const N = Number(n);
  const results = [
    await scenario(host, port, 'xadd only, 1 conn', N, 1, false),
    await scenario(host, port, 'xadd + WAITAOF 1 0, 1 conn', Math.min(N, 60), 1, true),
    await scenario(host, port, 'xadd + WAITAOF 1 0, 50 conns', N, 50, true),
  ];
  console.log(JSON.stringify({ server: version, appendfsync: fsync, results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
