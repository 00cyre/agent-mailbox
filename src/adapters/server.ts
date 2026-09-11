import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { envelopeFromSendBody, type AdapterHub } from './hub.js';
import { parseAddress } from './protocol.js';

const MAX_BODY_BYTES = 512 * 1024;
const MAX_WAIT_MS = 300_000;

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function fail(res: ServerResponse, code: number, message: string): void {
  json(res, code, { error: { code, message } });
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Loopback face for the Cursor and Grok adapters.
 *
 * The mailbox hub (or another vendor) POSTs an envelope to `/v1/send`. Replies
 * are pulled with `/v1/receive?address=cursor:bc-…` and must be delivered to
 * `reply_to`. This is not a second mailbox — it is `send(threadId, envelope)`
 * plus listen, over HTTP.
 */
export function createAdapterServer(hub: AdapterHub): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) fail(res, 400, message);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/u, '') || '/';

    if (path === '/healthz') return json(res, 200, { status: 'ok', vendors: ['cursor', 'grok'] });

    if (req.method === 'POST' && path === '/v1/send') {
      const envelope = envelopeFromSendBody(await readBody(req));
      parseAddress(envelope.to);
      const result = await hub.send(envelope);
      return json(res, 201, {
        ...result.envelope,
        transport: result.transport,
        native_id: result.nativeId ?? null,
      });
    }

    if (req.method === 'GET' && path === '/v1/receive') {
      const address = url.searchParams.get('address') ?? url.searchParams.get('to');
      if (!address) return fail(res, 400, 'pass address={vendor}:{thread_id}');
      const wait = Math.min(
        Math.max(Number(url.searchParams.get('wait') ?? '0') || 0, 0),
        MAX_WAIT_MS
      );
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const result = await hub.receive(address, cursor, wait);
      return json(res, 200, { data: result.envelopes, cursor: result.cursor });
    }

    return fail(res, 404, `no such route: ${req.method ?? 'GET'} ${path}`);
  }
}
