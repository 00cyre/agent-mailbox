import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { generateToken, hashToken } from '../../config.js';
import { buildReplyEnvelope, coerceAddress, type Envelope } from '../protocol.js';
import {
  CHANNEL_INSTRUCTIONS,
  channelMeta,
  formatChannelContent,
  normalizeClaudeThreadId,
} from './format.js';
import { parseEnvelope } from './envelope.js';
import {
  registerListener,
  unregisterListener,
  defaultStatePath,
  type ChannelNotify,
} from './channel-registry.js';

const MAX_BODY = 512 * 1024;

export interface ChannelServerOptions {
  threadId: string;
  notify?: (content: string, meta: Record<string, string>) => Promise<void>;
  onReply?: (reply: Envelope) => Promise<void>;
  host?: string;
  port?: number;
  /**
   * Bearer token required on `POST /send`. One is minted when omitted — this
   * surface is never unauthenticated, because reaching it means writing a turn
   * into a live session, not queueing mail someone can ignore.
   */
  token?: string;
  statePath?: string;
  now?: () => string;
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
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Claude Code channel: inbound envelopes become `notifications/claude/channel`
 * (native in-thread delivery, the same path as @-mentions). The `reply` tool
 * sends back to `chat_id` with `correlation_id` preserved.
 */
export function replyEnvelopeFromTool(input: {
  threadId: string;
  last?: Envelope;
  chatId: string;
  text: string;
  correlationId?: string;
  now?: string;
}): Envelope {
  const chat = coerceAddress(input.chatId) ?? { vendor: 'unknown', thread_id: input.chatId };
  const inbound: Envelope = input.last ?? {
    id: 'unknown',
    from: chat,
    to: { vendor: 'claude', thread_id: input.threadId },
    reply_to: chat,
    ...(input.correlationId !== undefined ? { correlation_id: input.correlationId } : {}),
    body: '(no inbound envelope cached)',
    created_at: input.now ?? new Date().toISOString(),
  };
  const withCorr: Envelope = {
    ...inbound,
    reply_to: inbound.reply_to ?? chat,
    ...(input.correlationId !== undefined
      ? { correlation_id: input.correlationId }
      : inbound.correlation_id !== undefined
        ? { correlation_id: inbound.correlation_id }
        : {}),
  };
  const reply = buildReplyEnvelope({
    threadId: input.threadId,
    inbound: withCorr,
    body: input.text,
  });
  reply.to = chat;
  return reply;
}

export function createClaudeChannelMcp(options: ChannelServerOptions): {
  mcp: McpServer;
  deliver: ChannelNotify;
  lastInbound: () => Envelope | undefined;
} {
  const threadId = normalizeClaudeThreadId(options.threadId);
  let last: Envelope | undefined;

  const mcp = new McpServer(
    { name: 'mailbox-claude', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: CHANNEL_INSTRUCTIONS,
    }
  );

  const deliver: ChannelNotify = async (envelope) => {
    last = envelope;
    const content = formatChannelContent(envelope);
    const meta = channelMeta(envelope);
    if (options.notify) {
      await options.notify(content, meta);
      return;
    }
    await mcp.server.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    } as never);
  };

  mcp.registerTool(
    'reply',
    {
      title: 'Reply over mailbox',
      description:
        'Send a reply back to the originating agent thread. Pass chat_id from the inbound <channel> tag, and correlation_id unchanged.',
      inputSchema: {
        chat_id: z
          .string()
          .describe('Destination address (vendor:thread). Use the chat_id attribute from the inbound channel event.'),
        text: z.string().min(1).describe('Reply body, markdown.'),
        correlation_id: z
          .string()
          .optional()
          .describe('Copy from the inbound tag so the other thread can pair this reply.'),
      },
    },
    async (args) => {
      try {
        const reply = replyEnvelopeFromTool({
          threadId,
          ...(last !== undefined ? { last } : {}),
          chatId: args.chat_id,
          text: args.text,
          ...(args.correlation_id !== undefined ? { correlationId: args.correlation_id } : {}),
          ...(options.now ? { now: options.now() } : {}),
        });
        if (options.onReply) await options.onReply(reply);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ sent: true, id: reply.id, to: reply.to }) }],
        };
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        };
      }
    }
  );

  return { mcp, deliver, lastInbound: () => last };
}

export async function serveClaudeChannel(options: ChannelServerOptions): Promise<{
  close: () => Promise<void>;
  url: string;
  deliver: ChannelNotify;
}> {
  const { mcp, deliver } = createClaudeChannelMcp(options);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  const host = options.host ?? '127.0.0.1';
  const statePath = options.statePath ?? defaultStatePath();
  const threadId = normalizeClaudeThreadId(options.threadId);
  const token = options.token ?? generateToken('channel');
  const tokenHash = hashToken(token);

  /**
   * Loopback is not an authorization boundary here. The premise of this machine
   * is that several agents run on it locally, so "only local processes can
   * reach the port" describes the attacker, not a defence against one.
   */
  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
    if (!match) return false;
    const a = Buffer.from(hashToken(match[1]!), 'hex');
    const b = Buffer.from(tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const seen = new Set<string>();
  const deliverOnce: ChannelNotify = async (envelope) => {
    if (seen.has(envelope.id)) return;
    seen.add(envelope.id);
    if (seen.size > 400) {
      const first = seen.values().next().value;
      if (typeof first === 'string') seen.delete(first);
    }
    await deliver(envelope);
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
      } else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    if (path === '/healthz') return json(res, 200, { status: 'ok', thread: threadId });
    if (req.method === 'POST' && path === '/send') {
      if (!authorized(req)) {
        res.setHeader('www-authenticate', 'Bearer');
        return json(res, 401, { error: { message: 'a bearer token is required to inject into this session' } });
      }
      const body = (await readBody(req)) as { envelope?: unknown; threadId?: string };
      const envelope = parseEnvelope(body.envelope ?? body);
      const target = envelope.to.thread_id;
      if (target !== threadId && threadId !== '*') {
        return json(res, 404, { error: { message: `this channel is bound to claude:${threadId}` } });
      }
      await deliverOnce(envelope);
      return json(res, 202, { delivered: true });
    }
    return json(res, 404, { error: { message: `no such route: ${req.method} ${path}` } });
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('channel HTTP failed to bind');
  const url = `http://${host}:${address.port}`;

  registerListener(statePath, {
    threadId,
    url,
    pid: process.pid,
    updated_at: new Date().toISOString(),
    token,
  });

  const heartbeat = setInterval(() => {
    registerListener(statePath, {
      threadId,
      url,
      pid: process.pid,
      updated_at: new Date().toISOString(),
      token,
    });
  }, 15_000);
  heartbeat.unref();

  const close = async (): Promise<void> => {
    clearInterval(heartbeat);
    unregisterListener(statePath, threadId, process.pid);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mcp.close();
  };

  process.on('SIGINT', () => void close().then(() => process.exit(0)));
  process.on('SIGTERM', () => void close().then(() => process.exit(0)));

  process.stderr.write(`mailbox-claude channel on ${url} for claude:${threadId}\n`);
  return { close, url, deliver: deliverOnce };
}
