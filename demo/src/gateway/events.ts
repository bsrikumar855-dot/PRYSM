import type { ServerResponse } from 'node:http';

// DEMO-ONLY (TODO(T-001)). A tiny server-sent-events hub for the dashboard. Events carry only data that is already
// safe to show: evidence records (redacted by construction), approval queue contents and verification results.

export class EventHub {
  readonly #clients = new Set<ServerResponse>();
  #keepalive: NodeJS.Timeout | undefined;

  /** Starts streaming to a response. `hello` events are sent first. */
  subscribe(res: ServerResponse, hello: { event: string; data: unknown }[]): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    for (const e of hello) res.write(frame(e.event, e.data));
    this.#clients.add(res);
    res.on('close', () => {
      this.#clients.delete(res);
    });
    this.#keepalive ??= setInterval(() => {
      for (const c of this.#clients) c.write(': keepalive\n\n');
    }, 15_000);
    this.#keepalive.unref();
  }

  publish(event: string, data: unknown): void {
    const text = frame(event, data);
    for (const c of this.#clients) c.write(text);
  }

  get size(): number {
    return this.#clients.size;
  }

  close(): void {
    if (this.#keepalive) clearInterval(this.#keepalive);
    for (const c of this.#clients) c.end();
    this.#clients.clear();
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
