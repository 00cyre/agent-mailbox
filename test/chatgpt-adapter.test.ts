import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatGptAdapter } from '../src/adapters/chatgpt.js';
import { addr, coerceEnvelope } from '../src/adapters/format.js';
import type { MacDriver } from '../src/adapters/mac.js';
import type { Envelope } from '../src/protocol.js';

const envelope: Envelope = {
  id: 'm1',
  from: addr('codex', 'src'),
  to: addr('chatgpt', 'conv-1'),
  reply_to: addr('codex', 'src'),
  body: 'status update',
  created_at: '2026-09-11T00:00:00.000Z',
};

function macSpy(platform: NodeJS.Platform): MacDriver & {
  opens: string[];
  copied: string[];
  pasted: string[];
} {
  const opens: string[] = [];
  const copied: string[] = [];
  const pasted: string[] = [];
  return {
    platform,
    opens,
    copied,
    pasted,
    openUrl: async (url) => {
      opens.push(url);
    },
    copy: async (text) => {
      copied.push(text);
    },
    pasteAndSubmit: async (app) => {
      pasted.push(app.bundleId);
    },
    readVisibleText: async () => 'visible',
  };
}

describe('chatgpt adapter', () => {
  it('refuses to inject on Linux without a Mac wrapper', async () => {
    const adapter = new ChatGptAdapter({ platform: 'linux', mac: macSpy('linux') });
    await assert.rejects(adapter.send('conv-1', envelope), /no public send-to-thread API/u);
  });

  it('opens the ChatGPT conversation then pastes on macOS', async () => {
    const mac = macSpy('darwin');
    const adapter = new ChatGptAdapter({ platform: 'darwin', mac, sleep: async () => undefined });
    await adapter.send('conv-1', envelope);
    assert.ok(
      mac.opens.some((url) => url.includes('chatgpt.com/c/conv-1') || url.includes('com.openai.chat://')),
      mac.opens.join(',')
    );
    assert.match(mac.copied[0] ?? '', /status update/u);
    assert.match(mac.copied[0] ?? '', /reply_to: codex:src/u);
    assert.ok(mac.pasted.length > 0);
  });

  it('POSTs to a remote Mac wrapper when configured', async () => {
    const seen: unknown[] = [];
    const adapter = new ChatGptAdapter({
      platform: 'linux',
      wrapperUrl: 'http://127.0.0.1:8790',
      fetchImpl: (async (_url, init) => {
        seen.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ reply: 'wrapper-ok' }), { status: 200 });
      }) as typeof fetch,
    });
    const replies: string[] = [];
    const stop = adapter.listen('conv-1', (body) => {
      replies.push(body);
    });
    await adapter.send('conv-1', envelope);
    stop();
    const payload = seen[0] as { threadId: string; envelope: { body: string } };
    assert.equal(payload.threadId, 'conv-1');
    assert.equal(payload.envelope.body, 'status update');
    assert.deepEqual(replies, ['wrapper-ok']);
  });

  it('accepts string or object addresses on the HTTP envelope', () => {
    const parsed = coerceEnvelope({
      id: '1',
      from: 'claude:a',
      to: { vendor: 'chatgpt', thread_id: 'c1' },
      reply_to: 'claude:a',
      body: 'hi',
      created_at: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(parsed.from.vendor, 'claude');
    assert.equal(parsed.to.thread_id, 'c1');
  });
});
