#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { ClaudeAdapter } from './adapter.js';
import { bridgeLoop, HubClient } from './bridge.js';
import { serveClaudeChannel } from './channel.js';
import { parseEnvelope } from './envelope.js';
import { ChannelTransport } from './channel-registry.js';
import { formatListenBlock, normalizeClaudeThreadId } from './format.js';
import { createClaudeSidecar } from './sidecar.js';
import {
  buildReplyEnvelope,
  envelopeSchema,
  newEnvelopeId,
  type Envelope,
} from '../protocol.js';

interface Flags {
  [key: string]: string | boolean | undefined;
}

export function parseClaudeArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
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

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const USAGE = `agent-mailbox claude — send/receive on a Claude thread (vendor claude)

  agent-mailbox claude send --thread <id> --from <addr> --body <text>
      Deliver one envelope into that Claude thread (channel, CLI, or Desktop).

  agent-mailbox claude listen --thread <id>
      Long-poll the hub and deliver each Claude-bound message into the thread.
      Replies captured by \`claude -p\` are posted back with reply_to / correlation_id.

  agent-mailbox claude channel --thread <id> [--port 0]
      MCP stdio channel for Claude Code (native in-thread inject + reply tool).
      Start Claude with:
        claude --dangerously-load-development-channels server:mailbox-claude

  agent-mailbox claude serve [--thread <id>] [--port 8790]
      Loopback sidecar the hub can POST /send to, plus listen if a token is set.

Addresses are {vendor}:{thread_id}. Replies go to reply_to, else from.
Mac Desktop setup: src/adapters/claude/MAC.md
`;

function hubFromFlags(flags: Flags): HubClient {
  const url = str(flags, 'url', process.env['MAILBOX_URL']) ?? 'http://127.0.0.1:8787';
  const token = str(flags, 'token', process.env['MAILBOX_TOKEN']);
  if (!token) die('no token: pass --token or set MAILBOX_TOKEN');
  return new HubClient({ url, token });
}

function adapterFromFlags(flags: Flags): ClaudeAdapter {
  const only = str(flags, 'transport');
  const dry = flags['dry-run'] === true || process.env['MAILBOX_CLAUDE_DRY_RUN'] === '1';
  const listenWriter =
    flags['quiet'] === true
      ? async () => undefined
      : (_id: string, envelope: Envelope) => {
          process.stdout.write(formatListenBlock(envelope));
        };
  const bin = str(flags, 'claude-bin');
  const cwd = str(flags, 'cwd');
  return new ClaudeAdapter({
    ...(only ? { transports: [only as 'channel' | 'code-cli' | 'desktop' | 'listen'] } : {}),
    desktop: {
      dryRun: dry,
      ...(str(flags, 'submit-key') === 'return' ? { submitKey: 'return' as const } : {}),
    },
    listenWriter,
    codeCli: {
      ...(bin ? { bin } : {}),
      ...(cwd ? { cwd } : {}),
    },
  });
}

function envelopeFromFlags(flags: Flags, threadId: string): Envelope {
  const body = str(flags, 'body') ?? (flags['body'] === true ? undefined : undefined);
  const text = body ?? (process.stdin.isTTY ? undefined : readFileSync(0, 'utf8'));
  if (!text?.trim()) die('send needs --body or stdin');
  const from = str(flags, 'from') ?? 'mailbox:cli';
  const replyTo = str(flags, 'reply-to');
  const correlation = str(flags, 'correlation-id');
  return envelopeSchema.parse({
    id: str(flags, 'id') ?? newEnvelopeId('claude'),
    from,
    to: `claude:${threadId}`,
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(correlation ? { correlation_id: correlation } : {}),
    body: text,
    created_at: new Date().toISOString(),
  });
}

export async function runClaudeCli(argv: string[]): Promise<void> {
  const { command, positional, flags } = parseClaudeArgs(argv);

  switch (command) {
    case 'send': {
      const threadId = normalizeClaudeThreadId(str(flags, 'thread') ?? positional[0] ?? '');
      if (!threadId) die('send needs --thread <claude thread id>');
      const adapter = adapterFromFlags({ ...flags, quiet: true });
      const envelope = envelopeFromFlags(flags, threadId);
      const result = await adapter.deliver(threadId, envelope);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    case 'listen': {
      const threadId = normalizeClaudeThreadId(str(flags, 'thread') ?? positional[0] ?? '');
      if (!threadId) die('listen needs --thread <claude thread id>');
      const hub = hubFromFlags(flags);
      const adapter = adapterFromFlags(flags);
      process.stderr.write(`listening for claude:${threadId}\n`);
      await bridgeLoop({
        hub,
        adapter,
        threadId,
        onDelivered: (envelope, result) => {
          process.stderr.write(`delivered ${envelope.id} via ${result.transport}\n`);
        },
      });
      return;
    }

    case 'channel': {
      const threadId = normalizeClaudeThreadId(str(flags, 'thread') ?? positional[0] ?? '');
      if (!threadId) die('channel needs --thread <claude thread id>');
      const hub = str(flags, 'token', process.env['MAILBOX_TOKEN'])
        ? hubFromFlags(flags)
        : undefined;
      const port = Number(str(flags, 'port', '0'));
      const session = await serveClaudeChannel({
        threadId,
        port: Number.isFinite(port) ? port : 0,
        ...(hub
          ? {
              onReply: async (reply) => {
                await hub.sendEnvelope(reply);
              },
            }
          : {}),
      });
      if (hub && flags['poll'] === true) {
        const adapter = new ClaudeAdapter({
          transports: ['channel'],
          channel: new ChannelTransport(),
          listenWriter: () => undefined,
        });
        adapter.channels.register(threadId, session.deliver);
        await bridgeLoop({ hub, adapter, threadId });
      }
      return;
    }

    case 'serve': {
      const threadId = str(flags, 'thread') ? normalizeClaudeThreadId(str(flags, 'thread')!) : undefined;
      const hub = str(flags, 'token', process.env['MAILBOX_TOKEN']) ? hubFromFlags(flags) : undefined;
      const adapter = adapterFromFlags(flags);
      const sidecar = createClaudeSidecar({
        adapter,
        ...(hub ? { hub } : {}),
        ...(threadId ? { defaultThreadId: threadId } : {}),
        host: str(flags, 'host') ?? '127.0.0.1',
        port: Number(str(flags, 'port') ?? '8790'),
      });
      sidecar.listen(Number(str(flags, 'port') ?? '8790'), str(flags, 'host') ?? '127.0.0.1', () => {
        const addr = sidecar.address() as AddressInfo;
        process.stdout.write(
          `claude adapter on http://${addr.address}:${addr.port}\n` +
            `  POST /send   { threadId, envelope }\n` +
            `  POST /reply  { chat_id, text, correlation_id? }\n`
        );
      });
      if (hub) {
        void bridgeLoop({
          hub,
          adapter,
          ...(threadId ? { threadId } : {}),
          onDelivered: (envelope, result) => {
            process.stderr.write(`delivered ${envelope.id} via ${result.transport}\n`);
          },
        });
      }
      return;
    }

    case 'reply-from-cli': {
      // Hidden helper used by tests / scripts: build a reply envelope JSON.
      const inbound = parseEnvelope(JSON.parse(str(flags, 'inbound') ?? '{}'));
      const threadId = normalizeClaudeThreadId(str(flags, 'thread') ?? '');
      const body = str(flags, 'body') ?? '';
      process.stdout.write(`${JSON.stringify(buildReplyEnvelope({ threadId, inbound, body }), null, 2)}\n`);
      return;
    }

    default:
      process.stdout.write(USAGE);
      if (command !== 'help') process.exit(1);
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return entry.replace(/\\/gu, '/').endsWith('adapters/claude/cli.js');
  }
}

if (invokedDirectly()) {
  runClaudeCli(process.argv.slice(2)).catch((error: unknown) => {
    die(error instanceof Error ? error.message : String(error));
  });
}
