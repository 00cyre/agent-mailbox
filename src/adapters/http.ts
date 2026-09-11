import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { coerceEnvelope } from './format.js';
import type { ListeningAdapter } from './types.js';

const MAX_BODY_BYTES = 512 * 1024;

export interface AdapterHttpOptions {
  adapter: ListeningAdapter;
  /** Optional. When set, local callers must send Authorization: Bearer. */
  token?: string;
  /** Wait this long for a native reply after send. 0 = don't wait. */
  replyTimeoutMs?: number;
}

/**
 * Loopback inject API for the Mac wrapper: `POST /send` is `send(threadId, envelope)`.
 * Bind this to 127.0.0.1 — it drives Accessibility on the local desktop.
 */
export function createAdapterHttpServer(options: AdapterHttpOptions): Server {
  const { adapter } = options;
  const replyTimeout = options.replyTimeoutMs ?? 180_000;

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) json(res, 400, { error: { message } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/u, '') || '/';

    if (path === '/healthz') return json(res, 200, { status: 'ok', vendor: adapter.vendor });

    if (options.token) {
      const header = req.headers.authorization;
      const token = header && /^Bearer\s+(\S+)$/iu.exec(header.trim())?.[1];
      if (token !== options.token) {
        res.setHeader('www-authenticate', 'Bearer');
        return json(res, 401, { error: { message: 'send Authorization: Bearer <token>' } });
      }
    }

    if (req.method === 'POST' && (path === '/send' || path === '/v1/send')) {
      const body = (await readBody(req)) as { threadId?: string; envelope?: unknown };
      const threadId = body.threadId;
      if (!threadId || typeof threadId !== 'string') {
        return json(res, 400, { error: { message: 'threadId is required' } });
      }
      let envelope;
      try {
        envelope = coerceEnvelope(body.envelope);
      } catch (error) {
        return json(res, 400, { error: { message: error instanceof Error ? error.message : 'invalid envelope' } });
      }
      const pending =
        replyTimeout > 0 ? adapter.replies.wait(threadId, replyTimeout).catch(() => undefined) : undefined;
      await adapter.send(threadId, envelope);
      const reply = pending ? await pending : undefined;
      return json(res, 201, { ok: true, vendor: adapter.vendor, threadId, reply: reply ?? null });
    }

    return json(res, 404, { error: { message: `no such route: ${req.method ?? 'GET'} ${path}` } });
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
