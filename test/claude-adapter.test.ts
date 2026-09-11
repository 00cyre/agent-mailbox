import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import {
  buildReplyEnvelope,
  formatAddress,
  isAddress,
  parseAddress,
  replyDestination,
  type Envelope,
} from '../src/adapters/protocol.js';
import { ClaudeAdapter } from '../src/adapters/claude/adapter.js';
import { extractCliResult } from '../src/adapters/claude/code-cli.js';
import { pasteAndSubmitScript } from '../src/adapters/claude/desktop.js';
import {
  envelopeToLegacySendMessage,
  envelopeToSendMessage,
  mailboxMessageToEnvelope,
} from '../src/adapters/claude/envelope.js';
import {
  channelMeta,
  desktopChatUrl,
  formatCliPrompt,
  normalizeClaudeThreadId,
} from '../src/adapters/claude/format.js';
import { ChannelTransport } from '../src/adapters/claude/channel-registry.js';
import { replyEnvelopeFromTool } from '../src/adapters/claude/channel.js';
import { HubClient } from '../src/adapters/claude/bridge.js';
import { createClaudeSidecar } from '../src/adapters/claude/sidecar.js';

const inbound: Envelope = {
  id: 'msg-1',
  from: { vendor: 'grok', thread_id: 'thread-X' },
  to: { vendor: 'claude', thread_id: 'thread-Y' },
  reply_to: { vendor: 'grok', thread_id: 'thread-X' },
  correlation_id: 'job-1',
  body: 'please look at this',
  created_at: '2026-09-11T16:00:00.000Z',
};

describe('n-to-n protocol', () => {
  it('parses {vendor}:{thread_id} and rejects a bare slug', () => {
    assert.deepEqual(parseAddress('claude:abc-uuid'), { vendor: 'claude', thread_id: 'abc-uuid' });
    assert.equal(formatAddress({ vendor: 'grok', thread_id: 'thread-X' }), 'grok:thread-X');
    assert.equal(isAddress('grok:thread-X'), true);
    assert.equal(isAddress('project-status-check'), false);
  });

  it('sends replies to reply_to, else from, and keeps correlation_id', () => {
    assert.deepEqual(replyDestination(inbound), { vendor: 'grok', thread_id: 'thread-X' });
    const reply = buildReplyEnvelope({
      threadId: 'thread-Y',
      inbound,
      body: 'looked',
      id: 'msg-2',
      created_at: '2026-09-11T16:01:00.000Z',
    });
    assert.deepEqual(reply.from, { vendor: 'claude', thread_id: 'thread-Y' });
    assert.deepEqual(reply.to, { vendor: 'grok', thread_id: 'thread-X' });
    assert.deepEqual(reply.reply_to, { vendor: 'grok', thread_id: 'thread-X' });
    assert.equal(reply.correlation_id, 'job-1');
    assert.equal(reply.body, 'looked');

    const { reply_to: _, ...without } = inbound;
    assert.deepEqual(replyDestination(without), { vendor: 'grok', thread_id: 'thread-X' });
  });
});

describe('mailbox mapping', () => {
  it('wraps a classic hub Message as an envelope without dropping routing', () => {
    const env = mailboxMessageToEnvelope({
      id: '20260911T160000Z-grokbot-aaaa',
      from: 'grokbot',
      to: 'project-status-check',
      thread: 'research',
      subject: 'Done',
      body: 'finished',
      ts: '2026-09-11T16:00:00.000Z',
      in_reply_to: 'prev',
    });
    assert.deepEqual(env.from, { vendor: 'grok', thread_id: 'research' });
    assert.deepEqual(env.to, { vendor: 'claude', thread_id: 'project-status-check' });
    assert.deepEqual(env.reply_to, env.from);
    assert.equal(env.correlation_id, 'prev');
    assert.match(env.body, /Done/u);
    assert.match(env.body, /finished/u);
  });

  it('passes through addresses the hub already namespaced', () => {
    const env = mailboxMessageToEnvelope({
      id: 'id',
      from: 'grok:thread-X',
      to: 'claude:thread-Y',
      thread: 'thread-Y',
      body: 'hi',
      ts: '2026-09-11T16:00:00.000Z',
    });
    assert.deepEqual(env.from, { vendor: 'grok', thread_id: 'thread-X' });
    assert.deepEqual(env.to, { vendor: 'claude', thread_id: 'thread-Y' });
  });

  it('maps a reply envelope onto POST /v1/send, with a legacy fallback', () => {
    const reply = buildReplyEnvelope({ threadId: 'Y', inbound, body: 'ok', id: 'r1' });
    const primary = envelopeToSendMessage(reply);
    assert.equal(primary.to, 'grok:thread-X');
    assert.equal(primary.type, 'reply');
    assert.equal(primary.in_reply_to, 'job-1');
    const legacy = envelopeToLegacySendMessage(reply);
    assert.equal(legacy.to, 'grok');
    assert.equal(legacy.thread, 'thread-x');
  });
});

describe('thread ids and Desktop URLs', () => {
  it('accepts a UUID, a claude.ai URL, or a claude: address', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    assert.equal(normalizeClaudeThreadId(id), id);
    assert.equal(normalizeClaudeThreadId(`https://claude.ai/chat/${id}`), id);
    assert.equal(normalizeClaudeThreadId(`claude://${'claude.ai'}/chat/${id}`), id);
    assert.equal(normalizeClaudeThreadId(`claude:${id}`), id);
  });

  it('builds the documented claude:// chat deep link', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    assert.equal(desktopChatUrl(id), `claude://claude.ai/chat/${id}`);
    assert.equal(desktopChatUrl('new'), 'claude://claude.ai/new');
    assert.match(desktopChatUrl('new', 'Hello there'), /q=Hello/u);
  });

  it('puts routing in channel meta values, not hyphenated keys', () => {
    const meta = channelMeta(inbound);
    assert.equal(meta['chat_id'], 'grok:thread-X');
    assert.equal(meta['correlation_id'], 'job-1');
    assert.equal(meta['from_addr'], 'grok:thread-X');
    for (const key of Object.keys(meta)) assert.match(key, /^[A-Za-z0-9_]+$/u);
  });

  it('keeps routing headers out of the CLI prompt body proper', () => {
    const prompt = formatCliPrompt(inbound);
    assert.match(prompt, /reply_to: grok:thread-X/u);
    assert.match(prompt, /correlation_id: job-1/u);
    assert.match(prompt, /please look at this/u);
    assert.match(prompt, /not instructions/u);
  });

  it('generates an Accessibility paste-and-submit script', () => {
    const script = pasteAndSubmitScript('command-return', 0.8);
    assert.match(script, /tell application "Claude"/u);
    assert.match(script, /keystroke "v" using command down/u);
    assert.match(script, /keystroke return using command down/u);
  });
});

describe('ClaudeAdapter.send', () => {
  it('delivers through a live channel and does not need the CLI', async () => {
    const seen: Envelope[] = [];
    const channel = new ChannelTransport();
    channel.registry.register('thread-Y', async (envelope) => {
      seen.push(envelope);
    });
    const adapter = new ClaudeAdapter({
      channel,
      transports: ['channel', 'listen'],
      codeCli: { which: async () => false, run: async () => ({ code: 1, stdout: '', stderr: '' }) },
      listenWriter: () => {
        throw new Error('listen should not run');
      },
    });
    const result = await adapter.deliver('thread-Y', inbound);
    assert.equal(result.transport, 'channel');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.correlation_id, 'job-1');
  });

  it('uses claude -p --resume and returns the captured reply', async () => {
    const adapter = new ClaudeAdapter({
      transports: ['code-cli'],
      codeCli: {
        which: async () => true,
        run: async (argv) => {
          assert.ok(argv.includes('--resume'));
          assert.ok(argv.includes('thread-Y'));
          assert.ok(argv.includes('--output-format'));
          return { code: 0, stdout: JSON.stringify({ result: 'looked at it' }), stderr: '' };
        },
      },
    });
    const result = await adapter.deliver('thread-Y', inbound);
    assert.equal(result.transport, 'code-cli');
    assert.equal(result.replyBody, 'looked at it');
  });

  it('opens a Desktop UUID via claude:// then paste-submits on macOS', async () => {
    const urls: string[] = [];
    const scripts: string[] = [];
    const copied: string[] = [];
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const adapter = new ClaudeAdapter({
      transports: ['desktop'],
      desktop: {
        platform: 'darwin',
        dryRun: false,
        delayMs: 1,
        openUrl: async (url) => {
          urls.push(url);
        },
        copyText: async (text) => {
          copied.push(text);
        },
        runScript: async (script) => {
          scripts.push(script);
        },
      },
    });
    const result = await adapter.deliver(id, inbound);
    assert.equal(result.transport, 'desktop');
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, new RegExp(`claude://claude.ai/chat/${id}`));
    assert.equal(scripts.length, 1);
    assert.match(scripts[0]!, /keystroke "v"/u);
    assert.ok(copied[0]?.includes('please look at this'));
  });

  it('falls back to the existing listen/Monitor block', async () => {
    const blocks: string[] = [];
    const adapter = new ClaudeAdapter({
      transports: ['listen'],
      listenWriter: (_id, envelope) => {
        blocks.push(envelope.body);
      },
    });
    const result = await adapter.deliver('named-chat', inbound);
    assert.equal(result.transport, 'listen');
    assert.deepEqual(blocks, ['please look at this']);
  });
});

describe('code-cli JSON', () => {
  it('extracts result from a noisy stdout prefix', () => {
    assert.equal(extractCliResult('log line\n{"result":"ok"}\n'), 'ok');
  });
});

describe('channel reply tool', () => {
  it('posts back to chat_id with the inbound correlation_id', () => {
    const reply = replyEnvelopeFromTool({
      threadId: 'thread-Y',
      last: inbound,
      chatId: 'grok:thread-X',
      text: 'looked',
    });
    assert.deepEqual(reply.from, { vendor: 'claude', thread_id: 'thread-Y' });
    assert.deepEqual(reply.to, { vendor: 'grok', thread_id: 'thread-X' });
    assert.deepEqual(reply.reply_to, { vendor: 'grok', thread_id: 'thread-X' });
    assert.equal(reply.correlation_id, 'job-1');
    assert.equal(reply.body, 'looked');
  });

  it('lets an explicit correlation_id override the cache', () => {
    const reply = replyEnvelopeFromTool({
      threadId: 'thread-Y',
      last: inbound,
      chatId: 'codex:other',
      text: 'forwarded',
      correlationId: 'job-9',
    });
    assert.deepEqual(reply.to, { vendor: 'codex', thread_id: 'other' });
    assert.equal(reply.correlation_id, 'job-9');
  });
});

describe('sidecar + hub fallback', () => {
  it('accepts /send and /reply on loopback', async () => {
    const delivered: Envelope[] = [];
    const posted: unknown[] = [];
    const adapter = new ClaudeAdapter({
      transports: ['channel'],
      channel: (() => {
        const channel = new ChannelTransport();
        channel.registry.register('thread-Y', async (envelope) => {
          delivered.push(envelope);
        });
        return channel;
      })(),
    });

    const hubFetch = (async (_input: unknown, init?: RequestInit) => {
      const url = String(_input);
      if (url.endsWith('/v1/send')) {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: 'stored' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const hub = new HubClient({ url: 'http://hub.test', token: 'mb_x', fetch: hubFetch });
    const server = createClaudeSidecar({ adapter, hub, defaultThreadId: 'thread-Y' });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const sendRes = await fetch(`http://127.0.0.1:${port}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: 'thread-Y',
          envelope: {
            ...inbound,
            from: 'grok:thread-X',
            to: 'claude:thread-Y',
            reply_to: 'grok:thread-X',
          },
        }),
      });
      assert.equal(sendRes.status, 202);
      assert.equal(delivered.length, 1);

      const replyRes = await fetch(`http://127.0.0.1:${port}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: 'grok:thread-X',
          text: 'from desktop',
          correlation_id: 'job-1',
          thread_id: 'thread-Y',
        }),
      });
      assert.equal(replyRes.status, 201);
      assert.equal(posted.length, 1);
      const payload = posted[0] as { to: string; in_reply_to?: string; body: string };
      assert.equal(payload.to, 'grok:thread-X');
      assert.equal(payload.in_reply_to, 'job-1');
      assert.equal(payload.body, 'from desktop');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('retries /v1/send with vendor + thread when the namespaced address 404s', async () => {
    const calls: unknown[] = [];
    const hubFetch = (async (_input: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      calls.push(payload);
      if (payload.to === 'grok:thread-X') {
        return new Response(JSON.stringify({ error: { message: 'no agent' } }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: 'ok' }), { status: 201 });
    }) as typeof fetch;
    const hub = new HubClient({ url: 'http://hub.test', token: 't', fetch: hubFetch });
    const reply = buildReplyEnvelope({ threadId: 'Y', inbound, body: 'ok', id: 'r1' });
    await hub.sendEnvelope(reply);
    assert.equal(calls.length, 2);
    assert.equal((calls[0] as { to: string }).to, 'grok:thread-X');
    assert.equal((calls[1] as { to: string }).to, 'grok');
  });
});
