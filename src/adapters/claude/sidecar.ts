import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { buildReplyEnvelope, coerceAddress, envelopeSchema, type Envelope } from '../protocol.js';
import { ClaudeAdapter } from './adapter.js';
import { HubClient } from './bridge.js';
import { parseEnvelope } from './envelope.js';
import { normalizeClaudeThreadId } from './format.js';

const MAX_BODY = 512 * 1024;

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
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export interface SidecarOptions {
  adapter: ClaudeAdapter;
  hub?: HubClient;
  host?: string;
  port?: number;
  defaultThreadId?: string;
}

/**
 * Loopback HTTP face of the Claude adapter. The hub can POST an envelope here
 * when it dispatches `claude:*` out-of-process. Claude Desktop can POST /reply
 * after a human (or MCP) send, preserving reply_to / correlation_id.
 */
export function createClaudeSidecar(options: SidecarOptions): Server {
  const host = options.host ?? '127.0.0.1';
  const adapter = options.adapter;
  const hub = options.hub;

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 400, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      } else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const path = url.pathname.replace(/\/+$/u, '') || '/';

    if (path === '/healthz') {
      return json(res, 200, { status: 'ok', vendor: 'claude' });
    }

    if (req.method === 'POST' && path === '/send') {
      const body = (await readBody(req)) as { threadId?: string; envelope?: unknown };
      const envelope = parseEnvelope(body.envelope ?? body);
      const threadId = normalizeClaudeThreadId(
        body.threadId ?? options.defaultThreadId ?? envelope.to.thread_id
      );
      const result = await adapter.deliver(threadId, envelope);
      if (result.replyBody && hub) {
        await hub.sendEnvelope(
          buildReplyEnvelope({ threadId, inbound: envelope, body: result.replyBody })
        );
      }
      return json(res, 202, result);
    }

    if (req.method === 'POST' && path === '/reply') {
      const body = (await readBody(req)) as {
        chat_id?: string;
        text?: string;
        correlation_id?: string;
        thread_id?: string;
        inbound?: unknown;
      };
      if (!body.chat_id || !body.text) {
        return json(res, 400, { error: { message: 'reply needs chat_id and text' } });
      }
      const threadId = normalizeClaudeThreadId(
        body.thread_id ?? options.defaultThreadId ?? 'unknown'
      );
      const chat = coerceAddress(body.chat_id);
      if (!chat) {
        return json(res, 400, { error: { message: 'chat_id must be vendor:thread_id' } });
      }
      const inbound: Envelope = body.inbound
        ? envelopeSchema.parse(body.inbound)
        : {
            id: body.correlation_id ?? 'inbound',
            from: chat,
            to: { vendor: 'claude', thread_id: threadId },
            reply_to: chat,
            ...(body.correlation_id !== undefined ? { correlation_id: body.correlation_id } : {}),
            body: '(desktop reply)',
            created_at: new Date().toISOString(),
          };
      const reply = buildReplyEnvelope({ threadId, inbound, body: body.text });
      reply.to = chat;
      if (!hub) return json(res, 503, { error: { message: 'no hub configured to accept replies' } });
      const stored = await hub.sendEnvelope(reply);
      return json(res, 201, { envelope: reply, stored });
    }

    return json(res, 404, { error: { message: `no such route: ${req.method} ${path}` } });
  }
}
