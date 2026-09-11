import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';

import { AgentRegistry, hashToken } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { MailStore } from '../src/store.js';
import { runBridge } from '../src/adapters/bridge.js';
import { HubClient } from '../src/adapters/hub.js';
import { createAdapterHttpServer } from '../src/adapters/http.js';
import { coerceEnvelope } from '../src/adapters/format.js';
import { ReplyBus } from '../src/adapters/replies.js';
import type { ListeningAdapter } from '../src/adapters/types.js';
import { formatAddress, type Envelope } from '../src/protocol.js';

const ALICE = 'mb_alice_testtoken0000000000';
const BOB = 'mb_bob_testtoken00000000000';

class FakeAdapter implements ListeningAdapter {
  readonly vendor: string;
  readonly replies = new ReplyBus();
  sent: Envelope[] = [];
  constructor(vendor: string) {
    this.vendor = vendor;
  }
  async send(threadId: string, envelope: Envelope): Promise<void> {
    this.sent.push(envelope);
    this.replies.emit(threadId, `ack:${envelope.body}`);
  }
  listen(threadId: string, onReply: (body: string) => void | Promise<void>): () => void {
    return this.replies.listen(threadId, (body) => {
      void onReply(body);
    });
  }
}

describe('bridge reply_to', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let store: MailStore;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mailbox-bridge-'));
    store = new MailStore({ dir });
    const agents = new AgentRegistry([
      { id: 'alice', tokenHash: hashToken(ALICE) },
      { id: 'bob', tokenHash: hashToken(BOB) },
    ]);
    server = createHttpServer({ store, agents });
    server.requestTimeout = 0;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function call(
    path: string,
    token: string,
    init: RequestInit = {}
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  it('injects hub mail into the vendor thread and returns the reply to reply_to', async () => {
    const adapter = new FakeAdapter('chatgpt');
    const hub = new HubClient({ url: base, token: BOB });
    const threadId = 'conv-xyz';
    const address = formatAddress({ vendor: 'chatgpt', thread_id: threadId });

    const bridging = runBridge({
      hub,
      adapter,
      threadId,
      maxInbound: 1,
      waitMs: 5_000,
      replyTimeoutMs: 5_000,
      startCursor: 0,
      log: () => undefined,
    });

    const deadline = Date.now() + 5_000;
    for (;;) {
      const listed = await call('/v1/chats', ALICE);
      const found = listed.body.data?.some(
        (c: { name: string; slug: string }) => c.name === address || c.slug === 'chatgpt-conv-xyz'
      );
      if (found) break;
      if (Date.now() > deadline) throw new Error('chat never registered');
      await new Promise((r) => setTimeout(r, 25));
    }

    const sent = await call('/v1/send', ALICE, {
      method: 'POST',
      body: JSON.stringify({
        to: address,
        thread: 'job-1',
        subject: 'ping',
        body: 'from alice',
        refs: ['mailbox:reply_to:alice', 'mailbox:correlation:job-1', 'mailbox:from:alice'],
      }),
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    await bridging;

    assert.equal(adapter.sent.length, 1);
    assert.equal(adapter.sent[0]!.body, 'from alice');
    assert.equal(adapter.sent[0]!.reply_to?.thread_id, 'alice');
    assert.equal(formatAddress(adapter.sent[0]!.to), address);

    let replies: any[] = [];
    const inboxDeadline = Date.now() + 5_000;
    while (Date.now() < inboxDeadline) {
      const inbox = await call('/v1/inbox?cursor=0&wait=0', ALICE);
      replies = inbox.body.data.filter((m: { from: string }) => m.from === 'bob');
      if (replies.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(replies.length, 1, JSON.stringify(replies));
    assert.equal(replies[0].to, 'alice');
    assert.equal(replies[0].body, 'ack:from alice');
    assert.equal(replies[0].type, 'reply');
    assert.ok(
      replies[0].refs.some((r: string) => r.startsWith('mailbox:reply_to:chatgpt:')),
      replies[0].refs
    );
  });
});

describe('adapter local HTTP', () => {
  it('accepts send(threadId, envelope) on loopback', async () => {
    const adapter = new FakeAdapter('codex');
    const server = createAdapterHttpServer({ adapter, replyTimeoutMs: 1_000 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const stop = adapter.listen('t1', () => undefined);
    try {
      const envelope = coerceEnvelope({
        from: 'claude:a',
        to: 'codex:t1',
        reply_to: 'claude:a',
        body: 'hi',
      });
      const response = await fetch(`http://127.0.0.1:${port}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 't1', envelope }),
      });
      assert.equal(response.status, 201);
      const body = (await response.json()) as { reply: string; vendor: string };
      assert.equal(body.vendor, 'codex');
      assert.equal(body.reply, 'ack:hi');
    } finally {
      stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
