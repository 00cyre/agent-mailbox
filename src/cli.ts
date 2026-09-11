#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AdapterRegistry } from './adapter.js';
import {
  AgentRegistry,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PORT,
  initConfig,
  loadConfig,
} from './config.js';
import * as service from './service.js';
import { chooseAgents } from './wizard.js';
import { createHttpServer } from './http.js';
import { MailboxHub } from './hub.js';
import { handleMcpRequest } from './mcp.js';
import { MailStore } from './store.js';
import type { Message } from './types.js';
import { formatAddress, parseAddress, type Envelope } from './protocol.js';
import {
  createEnvelope,
  createAdapterHttpServer,
  createAdapterServer,
  createMailboxClient,
  createVendorAdapter,
  defaultAdapterHub,
  HubClient,
  MAC_SETUP,
  newEnvelopeId,
  registerClaudeAdapter,
  registerCursorGrokAdapters,
  registerOpenaiAdapters,
  runBridge,
  runMailboxBridge,
  type ListeningAdapter,
} from './adapters/index.js';

/**
 * One binary, two audiences: `serve` runs the hub, everything else is a client
 * an agent (or a shell script, or a Claude Code Monitor) can drive.
 *
 * `watch` is the one that matters for chat integration — it prints one block
 * per inbound message and never exits, which is exactly the shape a monitoring
 * harness turns into a notification.
 */

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { command, positional, flags };
}

function str(flags: Flags, key: string, fallback?: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : fallback;
}

/** Re-emit parsed flags so a nested command (claude) can parse them itself. */
function argvFlags(flags: Flags): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === true) out.push(`--${key}`);
    else if (typeof value === 'string') out.push(`--${key}`, value);
  }
  return out;
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Where a client sends and what it sends as. Flags beat env; neither has a default. */
function clientConfig(flags: Flags): { url: string; token: string } {
  const url = str(flags, 'url', process.env['MAILBOX_URL']) ?? 'http://127.0.0.1:8787';
  const token = str(flags, 'token', process.env['MAILBOX_TOKEN']);
  if (!token) {
    die('no token: pass --token <token> or set MAILBOX_TOKEN (see mailbox.config.json)');
  }
  return { url: url.replace(/\/+$/u, ''), token };
}

async function api(
  url: string,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload['error'] as { message?: string } | undefined;
    throw new Error(`${response.status}: ${error?.message ?? JSON.stringify(payload)}`);
  }
  return payload;
}

const USAGE = `agent-mailbox — a mailbox any agent can post to

  Hub
    agent-mailbox init [<agent-id>...]     pick agents, mint tokens, write the config
                                           asks interactively; ids skip the menu
    agent-mailbox serve [--config <path>]  run the hub (HTTP + MCP)
    agent-mailbox service <action>         install|uninstall|status|restart|logs
                                           launchd on macOS, systemd --user on Linux

  Client  (needs --url/MAILBOX_URL and --token/MAILBOX_TOKEN)
    agent-mailbox whoami
    agent-mailbox agents
    agent-mailbox send --to <id|vendor:thread> --thread <slug> --subject <text> [--body <text>]
                                           [--from-thread <id>] [--reply-to <addr>] [--correlation-id <id>]
                                           body also reads stdin when --body is absent
    agent-mailbox inbox [--cursor <n>] [--thread <slug>]
    agent-mailbox watch [--thread <slug>] [--full]
                                           long-poll your own inbox, forever
    agent-mailbox listen --as "<chat name>" [--full]
                                           claim a chat name and receive its mail
    agent-mailbox chats                    who is listening, and under what name
    agent-mailbox threads
    agent-mailbox thread <slug>

  Adapters  (vendor:thread_id — same envelope as the hub)
    agent-mailbox claude send|listen|channel|serve
    agent-mailbox adapter serve [--port 8788]
    agent-mailbox adapter send --from <addr> --to <addr> --body <text>
    agent-mailbox adapt chatgpt|codex --thread <id>
    agent-mailbox adapt send --to <vendor:thread> --reply-to <addr> [--body <text>]
    agent-mailbox adapt serve chatgpt|codex --thread <id> [--port 8790]
`;

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'init': {
      // `--config` still wins, but the default now lives beside the service
      // rather than in whatever directory this was run from: a config in cwd
      // is invisible to a launchd job whose cwd is `/`.
      const path = str(flags, 'config', service.CONFIG)!;
      const choice = await chooseAgents({
        defaultPort: DEFAULT_PORT,
        ...(positional.length > 0 ? { preset: positional } : {}),
      });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const { path: written, tokens } = initConfig(path, choice.ids, {
        relay: choice.relay,
        port: choice.port,
        dataDir: service.DATA,
      });
      process.stdout.write(`\nwrote ${written} (mode 600)\n\n`);
      for (const { id, token } of tokens) {
        const tag = id === choice.relay ? ' (relay)' : '';
        process.stdout.write(`  ${id.padEnd(10)} ${token}${tag}\n`);
      }
      process.stdout.write(
        `\nThese are the only copies. Give each agent its own; the file stores hashes.\n` +
          `Next: agent-mailbox service install\n`
      );
      return;
    }

    case 'service': {
      const action = positional[0] ?? 'status';
      switch (action) {
        case 'install': {
          const written = service.install();
          process.stdout.write(
            `installed ${written} (${service.supervisor()})\n${service.status()}\n`
          );
          return;
        }
        case 'uninstall':
          process.stdout.write(`removed ${service.uninstall()}\n`);
          return;
        case 'status':
          process.stdout.write(`${service.status()}\n`);
          return;
        case 'restart':
          service.restart();
          process.stdout.write(`${service.status()}\n`);
          return;
        case 'logs': {
          const { out, err } = service.logPaths();
          process.stdout.write(`out: ${out}\nerr: ${err}\n`);
          return;
        }
        default:
          throw new Error(`unknown: service ${action} (install|uninstall|status|restart|logs)`);
      }
    }

    case 'serve': {
      const config = loadConfig(str(flags, 'config', DEFAULT_CONFIG_PATH)!);
      const store = new MailStore({ dir: config.dataDir });
      const agents = new AgentRegistry(config.agents);
      const adapters = AdapterRegistry.withStubs();
      registerClaudeAdapter(adapters);
      registerCursorGrokAdapters(adapters);
      registerOpenaiAdapters(adapters);
      const hub = new MailboxHub({ store, agents, adapters });
      const server = createHttpServer({
        store,
        agents,
        adapters,
        hub,
        mcpHandler: (req, res, agent, body) =>
          handleMcpRequest({ store, agents, hub, agent }, req, res, body),
      });

      // A long poll holds a socket for up to five minutes; without this the
      // server would close it at the default two.
      server.requestTimeout = 0;
      server.headersTimeout = 0;

      const shutdown = (): void => {
        store.close();
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      server.listen(config.port, config.host, () => {
        process.stdout.write(
          `agent-mailbox on http://${config.host}:${config.port}\n` +
            `  agents: ${config.agents.map((a) => a.id).join(', ')}\n` +
            `  data:   ${config.dataDir}\n` +
            `  mcp:    http://${config.host}:${config.port}/mcp\n`
        );
      });
      return;
    }

    case 'whoami': {
      const { url, token } = clientConfig(flags);
      process.stdout.write(`${JSON.stringify(await api(url, token, '/v1/whoami'), null, 2)}\n`);
      return;
    }

    case 'agents': {
      const { url, token } = clientConfig(flags);
      const result = (await api(url, token, '/v1/agents')) as { data: { id: string; description?: string }[] };
      for (const agent of result.data) {
        process.stdout.write(`${agent.id.padEnd(20)} ${agent.description ?? ''}\n`);
      }
      return;
    }

    case 'send': {
      const { url, token } = clientConfig(flags);
      const to = str(flags, 'to');
      const thread = str(flags, 'thread');
      const subject = str(flags, 'subject');
      if (!to) die('send needs --to (agent id, chat name, or vendor:thread_id)');
      const body = str(flags, 'body') ?? readFileSync(0, 'utf8');
      if (!body.trim()) die('empty body: pass --body <text> or pipe it on stdin');
      const message = (await api(url, token, '/v1/send', {
        method: 'POST',
        body: JSON.stringify({
          to,
          body,
          ...(thread ? { thread } : {}),
          ...(subject ? { subject } : {}),
          ...(str(flags, 'type') ? { type: str(flags, 'type') } : {}),
          ...(str(flags, 'in-reply-to') ? { in_reply_to: str(flags, 'in-reply-to') } : {}),
          ...(str(flags, 'from-thread') ? { from_thread: str(flags, 'from-thread') } : {}),
          ...(str(flags, 'reply-to') ? { reply_to: str(flags, 'reply-to') } : {}),
          ...(str(flags, 'correlation-id') ? { correlation_id: str(flags, 'correlation-id') } : {}),
        }),
      })) as Message;
      process.stdout.write(
        `sent ${message.id} (seq ${message.seq}) to ${message.to} on ${message.thread}\n`
      );
      return;
    }

    case 'inbox': {
      const { url, token } = clientConfig(flags);
      const params = new URLSearchParams({ wait: '0', cursor: str(flags, 'cursor', '0')! });
      if (str(flags, 'thread')) params.set('thread', str(flags, 'thread')!);
      const result = (await api(url, token, `/v1/inbox?${params}`)) as {
        data: Message[];
        cursor: number;
      };
      for (const message of result.data) render(message, flags['full'] === true);
      process.stdout.write(`cursor: ${result.cursor}\n`);
      return;
    }

    case 'watch': {
      const { url, token } = clientConfig(flags);
      const whoami = (await api(url, token, '/v1/whoami')) as { head: number };
      // Start at head, not zero: a watcher reports what arrives from now on.
      // Replaying the backlog on every restart would make a crash loop look
      // like a flood of new mail.
      const cursor = Number(str(flags, 'cursor', String(whoami.head)));
      const thread = str(flags, 'thread');
      const extra = thread ? `thread=${encodeURIComponent(thread)}` : '';
      await pollLoop(url, token, extra, cursor, flags['full'] === true);
      return;
    }

    case 'listen': {
      const { url, token } = clientConfig(flags);
      const name = str(flags, 'as') ?? positional[0];
      if (!name) die('listen needs the chat name: --as "Project status check"');

      // Claim the name first, then poll it. Registration is idempotent for the
      // same token, so this is also how a restarted listener reconnects.
      const chat = (await api(url, token, '/v1/chats', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })) as { slug: string; name: string };
      process.stderr.write(`listening as "${chat.name}" (${chat.slug})\n`);

      let cursor = Number(str(flags, 'cursor', '-1'));
      if (cursor < 0) {
        const whoami = (await api(url, token, '/v1/whoami')) as { head: number };
        cursor = whoami.head;
      }
      await pollLoop(url, token, `chat=${encodeURIComponent(chat.slug)}`, cursor, flags['full'] === true);
      return;
    }

    case 'chats': {
      const { url, token } = clientConfig(flags);
      const result = (await api(url, token, '/v1/chats')) as {
        data: { slug: string; name: string; listening: boolean; last_seen: string }[];
      };
      if (result.data.length === 0) process.stdout.write('no chats registered yet\n');
      for (const chat of result.data) {
        process.stdout.write(
          `${chat.listening ? '●' : '○'} ${chat.name}\n    slug: ${chat.slug}  last seen ${chat.last_seen}\n`
        );
      }
      return;
    }

    case 'threads': {
      const { url, token } = clientConfig(flags);
      const result = (await api(url, token, '/v1/threads')) as {
        data: { thread: string; count: number; last_ts: string }[];
      };
      for (const t of result.data) {
        process.stdout.write(`${t.thread.padEnd(28)} ${String(t.count).padStart(4)} msg  ${t.last_ts}\n`);
      }
      return;
    }

    case 'thread': {
      const { url, token } = clientConfig(flags);
      const name = positional[0];
      if (!name) die('thread needs a slug');
      const result = (await api(
        url,
        token,
        `/v1/threads/${encodeURIComponent(name)}`
      )) as { data: Message[] };
      for (const message of result.data) render(message, true);
      return;
    }

    case 'claude': {
      const { runClaudeCli } = await import('./adapters/claude/cli.js');
      await runClaudeCli([...positional, ...argvFlags(flags)]);
      return;
    }

    case 'adapter':
      await adapterCommand(positional, flags);
      return;

    case 'adapt': {
      await adaptCommand(positional, flags);
      return;
    }

    default:
      process.stdout.write(USAGE);
      if (command !== 'help') process.exit(1);
  }
}

/**
 * Long-poll forever, printing each message as it lands.
 *
 * Never exits and never throws: a watcher that dies when the hub bounces is
 * worse than useless, because silence and "no messages" look identical from the
 * outside. Failures go to stderr — stdout is the message stream, and a
 * monitoring harness reading it should not see an error as mail.
 */
async function pollLoop(
  url: string,
  token: string,
  extra: string,
  from: number,
  full: boolean
): Promise<never> {
  let cursor = from;
  for (;;) {
    const params = new URLSearchParams({ wait: '120000', cursor: String(cursor) });
    const query = extra ? `${params}&${extra}` : `${params}`;
    try {
      const result = (await api(url, token, `/v1/inbox?${query}`)) as {
        data: Message[];
        cursor: number;
      };
      for (const message of result.data) render(message, full);
      cursor = result.cursor;
    } catch (error) {
      process.stderr.write(`poll: ${error instanceof Error ? error.message : String(error)}\n`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}

/** One block per message. The first line is the one a notification shows. */
function render(message: Message, full: boolean): void {
  const body = full || message.body.length <= 600 ? message.body : `${message.body.slice(0, 600)}…`;
  process.stdout.write(
    `MAIL [${message.thread}] ${message.from} → ${message.to_name ?? message.to}${
      message.to_name ? ' (RELAY — deliver me)' : ''
    } :: ${message.subject}\n` +
      `${body}\n` +
      `(id ${message.id} seq ${message.seq} ${message.ts})\n\n`
  );
}

async function adapterCommand(positional: string[], flags: Flags): Promise<void> {
  const sub = positional[0] ?? 'help';
  const hub = defaultAdapterHub();

  if (sub === 'serve') {
    const port = Number(str(flags, 'port', process.env['ADAPTER_PORT'] ?? '8788'));
    const host = str(flags, 'host', process.env['ADAPTER_HOST'] ?? '127.0.0.1')!;
    const server = createAdapterServer(hub);
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    process.stdout.write(
      `cursor+grok adapter on http://${host}:${port}\n` +
        `  POST /v1/send   {from,to,reply_to,body}\n` +
        `  GET  /v1/receive?address=cursor:bc-…&wait=ms\n`
    );

    const token = str(flags, 'token', process.env['MAILBOX_TOKEN']);
    const mailboxUrl = str(flags, 'url', process.env['MAILBOX_URL']);
    if (token && mailboxUrl) {
      const client = await createMailboxClient(mailboxUrl, token);
      process.stdout.write(`  mailbox bridge ${mailboxUrl} as ${(await client.whoami()).agent.id}\n`);
      void runMailboxBridge(hub, client).catch((error: unknown) => {
        process.stderr.write(`bridge: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    return;
  }

  if (sub === 'send') {
    const from = str(flags, 'from');
    const to = str(flags, 'to');
    const body = str(flags, 'body') ?? (process.stdin.isTTY ? undefined : readFileSync(0, 'utf8'));
    if (!from || !to || !body?.trim()) die('adapter send needs --from, --to and --body');
    const replyTo = str(flags, 'reply-to');
    const envelope = createEnvelope({
      from,
      to,
      body,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    const result = await hub.send(envelope);
    process.stdout.write(
      `${JSON.stringify({ ...result.envelope, transport: result.transport, native_id: result.nativeId ?? null }, null, 2)}\n`
    );
    if (flags['wait'] === true) {
      const received = await hub.receive(to, result.nativeId, 180_000);
      for (const reply of received.envelopes) {
        process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`);
      }
    }
    return;
  }

  if (sub === 'listen') {
    const address = str(flags, 'address') ?? positional[1];
    if (!address) die('adapter listen needs --address {vendor}:{thread_id}');
    if (!parseAddress(address)) die(`address must be vendor:thread_id (got ${address})`);
    let cursor = str(flags, 'cursor');
    for (;;) {
      const received = await hub.receive(address, cursor, 25_000);
      for (const envelope of received.envelopes) {
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      }
      cursor = received.cursor;
    }
  }

  process.stdout.write(USAGE);
  if (sub !== 'help') process.exit(1);
}

async function adaptCommand(positional: string[], flags: Flags): Promise<void> {
  const sub = positional[0];
  if (sub === 'send') {
    await adaptSend(flags);
    return;
  }
  if (sub === 'serve') {
    const vendor = positional[1];
    if (vendor !== 'codex' && vendor !== 'chatgpt') {
      die('adapt serve needs a vendor: chatgpt | codex');
    }
    const thread = str(flags, 'thread') ?? positional[2];
    if (!thread) die('adapt serve needs --thread <id>');
    const adapter = makeAdapter(vendor, flags);
    const port = Number(str(flags, 'port', '8790'));
    const adapterToken = str(flags, 'token', process.env['MAILBOX_ADAPTER_TOKEN']);
    const server = createAdapterHttpServer({
      adapter,
      ...(adapterToken ? { token: adapterToken } : {}),
      replyTimeoutMs: Number(str(flags, 'reply-timeout', '180000')),
    });
    const stop = adapter.listen(thread, (body) => {
      process.stderr.write(`native reply on ${vendor}:${thread} (${body.length} chars)\n`);
    });
    const shutdown = (): void => {
      stop();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    process.stdout.write(
      `adapter ${vendor} on http://127.0.0.1:${port}\n` +
        `  POST /send { "threadId": "${thread}", "envelope": { ... } }\n` +
        (vendor === 'chatgpt' && process.platform !== 'darwin' ? `${MAC_SETUP}\n` : '')
    );
    return;
  }
  if (sub !== 'codex' && sub !== 'chatgpt') {
    die('adapt needs chatgpt | codex | send | serve');
  }
  const thread = str(flags, 'thread') ?? positional[1];
  if (!thread) die(`adapt ${sub} needs --thread <id>`);
  const { url, token } = clientConfig(flags);
  const adapter = makeAdapter(sub, flags);
  const httpPort = str(flags, 'http-port');
  if (httpPort) {
    const adapterToken = str(flags, 'adapter-token', process.env['MAILBOX_ADAPTER_TOKEN']);
    const server = createAdapterHttpServer({
      adapter,
      ...(adapterToken ? { token: adapterToken } : {}),
      replyTimeoutMs: Number(str(flags, 'reply-timeout', '180000')),
    });
    await new Promise<void>((resolve) => server.listen(Number(httpPort), '127.0.0.1', resolve));
    process.stderr.write(`adapter http on http://127.0.0.1:${httpPort}/send\n`);
  }
  await runBridge({
    hub: new HubClient({ url, token }),
    adapter,
    threadId: thread,
    replyTimeoutMs: Number(str(flags, 'reply-timeout', '600000')),
  });
}

function makeAdapter(vendor: 'codex' | 'chatgpt', flags: Flags): ListeningAdapter {
  if (vendor === 'codex') {
    const bin = str(flags, 'codex-bin');
    return createVendorAdapter('codex', {
      preferQueue: flags['no-queue'] !== true,
      ...(bin ? { bin } : {}),
    });
  }
  const wrapperUrl = str(flags, 'wrapper');
  return createVendorAdapter('chatgpt', {
    ...(wrapperUrl ? { wrapperUrl } : {}),
  });
}

async function adaptSend(flags: Flags): Promise<void> {
  const to = str(flags, 'to');
  const replyTo = str(flags, 'reply-to');
  if (!to || !replyTo) die('adapt send needs --to vendor:thread_id and --reply-to <addr>');
  const dest = parseAddress(to);
  if (!dest) die(`adapt send needs --to vendor:thread_id (got ${to})`);
  const vendor = dest.vendor;
  if (vendor !== 'codex' && vendor !== 'chatgpt') {
    die(`adapt send only implements codex and chatgpt addresses (got ${to})`);
  }
  const threadId = dest.thread_id;
  const body = str(flags, 'body') ?? readFileSync(0, 'utf8');
  if (!body.trim()) die('empty body: pass --body <text> or pipe it on stdin');
  const fromRaw = str(flags, 'from') ?? 'local:cli';
  const from = parseAddress(fromRaw) ?? { vendor: dest.vendor, thread_id: fromRaw };
  const replyParsed = parseAddress(replyTo);
  const reply_to = replyParsed ?? { vendor: 'agent', thread_id: replyTo };
  const correlationId = str(flags, 'correlation-id');
  const envelope: Envelope = {
    id: newEnvelopeId(),
    from,
    to: dest,
    reply_to,
    ...(correlationId ? { correlation_id: correlationId } : {}),
    body,
    created_at: new Date().toISOString(),
  };
  const adapter = makeAdapter(vendor, flags);
  const waiting = flags['wait'] === true ? adapter.replies.wait(threadId, 600_000) : undefined;
  const stop = adapter.listen(threadId, () => undefined);
  try {
    await adapter.send(threadId, envelope);
    process.stdout.write(`injected ${envelope.id} into ${formatAddress(dest)}\n`);
    if (waiting) {
      const reply = await waiting;
      process.stdout.write(`${reply}\n`);
    }
  } finally {
    stop();
  }
}

main().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
