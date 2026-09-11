import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentRegistry } from './config.js';
import type { MailStore } from './store.js';
import type { Agent } from './types.js';
import { publicAgent, registerChat, sendMessage } from './types.js';

/**
 * The HTTP face of the mailbox.
 *
 * Written against `node:http` rather than a framework on purpose: the whole
 * point of this package is that an agent with nothing but `curl` can join, and
 * that property is easier to keep if the server itself has nothing exotic in it
 * either. Six routes, one auth check, no middleware stack.
 */

const MAX_BODY_BYTES = 512 * 1024;
const MAX_WAIT_MS = 300_000;
const DEFAULT_WAIT_MS = 25_000;
/** A chat whose listener polled inside this window counts as present. */
const LISTENING_WINDOW_MS = 90_000;

export interface HttpDeps {
  store: MailStore;
  agents: AgentRegistry;
  /** Mounted at POST /mcp when present. The body is parsed here and handed over. */
  mcpHandler?: (
    req: IncomingMessage,
    res: ServerResponse,
    agent: Agent,
    body: unknown
  ) => Promise<void>;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function fail(res: ServerResponse, code: number, message: string, details?: unknown): void {
  json(res, code, { error: { code, message, details: details ?? null } });
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1];
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

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function createHttpServer(deps: HttpDeps): Server {
  const { store, agents } = deps;

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

    // Liveness. Unauthenticated, and it says nothing about who or what is here.
    if (path === '/healthz') return json(res, 200, { status: 'ok' });

    const agent = agents.authenticate(bearer(req));
    if (!agent) {
      res.setHeader('www-authenticate', 'Bearer');
      return fail(res, 401, 'send an Authorization: Bearer <token> header with a known token');
    }

    if (path === '/mcp') {
      if (!deps.mcpHandler) return fail(res, 404, 'MCP is not enabled on this mailbox');
      // GET and DELETE carry no body; only POST does. Reading one off a GET
      // would hang until the client gave up.
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      return deps.mcpHandler(req, res, agent, body);
    }

    if (req.method === 'GET' && path === '/v1/whoami') {
      return json(res, 200, {
        agent: publicAgent(agent),
        // A fresh reader starts here to receive only what arrives from now on.
        head: store.head,
      });
    }

    if (req.method === 'GET' && path === '/v1/agents') {
      return json(res, 200, { data: agents.list().map(publicAgent) });
    }

    // A chat claims its name as an address. Idempotent for the same owner, so
    // a listener just calls it every time it starts.
    if (req.method === 'POST' && path === '/v1/chats') {
      const parsed = registerChat.safeParse(await readBody(req));
      if (!parsed.success) return fail(res, 400, 'invalid chat', parsed.error.format());
      try {
        return json(res, 201, store.registerChat(agent.id, parsed.data.name));
      } catch (error) {
        return fail(res, 409, error instanceof Error ? error.message : String(error));
      }
    }

    // How a sender finds out where to write. This is the list a human reads
    // when they are about to paste a chat name into another agent's prompt.
    if (req.method === 'GET' && path === '/v1/chats') {
      return json(res, 200, {
        data: store.chats().map((chat) => ({
          slug: chat.slug,
          name: chat.name,
          last_seen: chat.lastSeen,
          // Mail to a quiet chat still queues; this only says whether someone
          // is likely to read it soon.
          listening: Date.now() - Date.parse(chat.lastSeen) < LISTENING_WINDOW_MS,
        })),
      });
    }

    if (req.method === 'POST' && path === '/v1/send') {
      if (agent.canSend === false) return fail(res, 403, `agent "${agent.id}" is read-only`);
      const parsed = sendMessage.safeParse(await readBody(req));
      if (!parsed.success) return fail(res, 400, 'invalid message', parsed.error.format());

      // Resolution order: broadcast, a registered agent, then a chat by slug or
      // by the display name someone pasted out of their client.
      const raw = parsed.data.to;
      let to: string;
      if (raw === '*') to = '*';
      else if (agents.has(raw)) to = raw;
      else {
        const chat = store.resolveChat(raw);
        if (!chat) {
          // Better a 404 than a message accepted and read by nobody. Name the
          // list that would have answered the question.
          return fail(
            res,
            404,
            `no agent or chat "${raw}" on this mailbox — GET /v1/chats lists the chats that are listening`
          );
        }
        to = chat.slug;
      }

      const message = store.send(agent.id, { ...parsed.data, to });
      return json(res, 201, message);
    }

    if (req.method === 'GET' && path === '/v1/inbox') {
      const cursor = intParam(url, 'cursor', 0);
      const wait = Math.min(Math.max(intParam(url, 'wait', DEFAULT_WAIT_MS), 0), MAX_WAIT_MS);
      const thread = url.searchParams.get('thread') ?? undefined;

      // A listener reads a chat's inbox rather than its own. Only the agent
      // that registered the chat may do so, or one token would read another
      // session's mail.
      const chatParam = url.searchParams.get('chat');
      let address = agent.id;
      if (chatParam !== null) {
        const chat = store.resolveChat(chatParam);
        if (!chat) return fail(res, 404, `no chat "${chatParam}"`);
        if (chat.owner !== agent.id) {
          return fail(res, 403, `chat "${chat.slug}" belongs to "${chat.owner}"`);
        }
        address = chat.slug;
        store.touchChat(chat.slug);
      }

      const messages =
        wait > 0
          ? await store.wait(address, cursor, wait, thread)
          : store.since(address, cursor, thread);
      // The cursor to send next time. Unchanged on an empty poll, so a reader
      // that times out simply asks again with the same number.
      const next = messages.length > 0 ? messages[messages.length - 1]!.seq : cursor;
      return json(res, 200, { data: messages, cursor: next });
    }

    if (req.method === 'GET' && path === '/v1/threads') {
      return json(res, 200, { data: store.threads(agent.id) });
    }

    const threadMatch = /^\/v1\/threads\/([^/]+)$/u.exec(path);
    if (req.method === 'GET' && threadMatch) {
      const name = decodeURIComponent(threadMatch[1]!);
      return json(res, 200, { data: store.thread(agent.id, name) });
    }

    return fail(res, 404, `no such route: ${req.method ?? 'GET'} ${path}`);
  }
}
