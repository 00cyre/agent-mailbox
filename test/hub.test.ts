import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AdapterRegistry, StubAdapter } from '../src/adapter.js';
import { AgentRegistry, hashToken } from '../src/config.js';
import { HubError, MailboxHub } from '../src/hub.js';
import { MailStore } from '../src/store.js';
import { sendMessage, type Agent, type SendMessage } from '../src/types.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(): {
  hub: MailboxHub;
  store: MailStore;
  adapters: AdapterRegistry;
  grok: Agent;
  codex: Agent;
  alice: Agent;
} {
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-hub-'));
  dirs.push(dir);
  const store = new MailStore({ dir });
  const agents = new AgentRegistry([
    { id: 'grok', tokenHash: hashToken('mb_grok_testtoken00000000'), vendor: 'grok' },
    { id: 'codex', tokenHash: hashToken('mb_codex_testtoken0000000'), vendor: 'codex' },
    { id: 'alice', tokenHash: hashToken('mb_alice_testtoken0000000') },
    { id: 'bob', tokenHash: hashToken('mb_bob_testtoken000000000') },
  ]);
  const adapters = AdapterRegistry.withStubs();
  const hub = new MailboxHub({ store, agents, adapters });
  return {
    hub,
    store,
    adapters,
    grok: agents.get('grok')!,
    codex: agents.get('codex')!,
    alice: agents.get('alice')!,
  };
}

const payload = (over: Partial<SendMessage> & Pick<SendMessage, 'to'>): SendMessage => ({
  body: 'hello',
  type: 'message',
  ...over,
});

describe('n-to-n routing', () => {
  it('routes grok:X → codex:Y through CodexAdapter.send(Y, envelope)', async () => {
    const { hub, adapters, grok, store } = setup();
    const message = await hub.send(
      grok,
      payload({ to: 'codex:thread-y', from_thread: 'thread-x', thread: 'research' })
    );

    assert.equal(message.from, 'grok:thread-x');
    assert.equal(message.to, 'codex:thread-y');
    assert.equal(message.reply_to, 'grok:thread-x');

    const stub = adapters.get('codex') as StubAdapter;
    assert.equal(stub.sent.length, 1);
    assert.equal(stub.sent[0]!.threadId, 'thread-y');
    assert.deepEqual(stub.sent[0]!.envelope.from, { vendor: 'grok', thread_id: 'thread-x' });
    assert.deepEqual(stub.sent[0]!.envelope.to, { vendor: 'codex', thread_id: 'thread-y' });
    assert.deepEqual(stub.sent[0]!.envelope.reply_to, { vendor: 'grok', thread_id: 'thread-x' });
    assert.equal(stub.sent[0]!.envelope.body, 'hello');
    assert.equal(stub.sent[0]!.envelope.id, message.id);
    assert.equal(stub.sent[0]!.envelope.created_at, message.ts);

    // Same append-only log the inbox already uses.
    assert.equal(store.since('codex', 0).length, 1);
    assert.equal(store.since('grok', 0).length, 0);
  });

  it('accepts {vendor, thread_id} objects as to / reply_to', async () => {
    const { hub, grok } = setup();
    const parsed = sendMessage.parse({
      to: { vendor: 'codex', thread_id: 'y' },
      from_thread: 'x',
      body: 'hello',
      reply_to: { vendor: 'grok', thread_id: 'x' },
    });
    const message = await hub.send(grok, parsed);
    assert.equal(message.to, 'codex:y');
    assert.equal(message.from, 'grok:x');
    assert.equal(message.reply_to, 'grok:x');
  });

  it('does not dispatch agent-to-agent mail through a vendor adapter', async () => {
    const { hub, adapters, alice } = setup();
    await hub.send(alice, payload({ to: 'bob', thread: 't', subject: 's' }));
    for (const adapter of adapters.list()) {
      assert.equal((adapter as StubAdapter).sent.length, 0, adapter.vendor);
    }
  });

  it('refuses a from address that is not this agent\'s vendor', async () => {
    const { hub, grok } = setup();
    await assert.rejects(
      () => hub.send(grok, payload({ to: 'codex:y', from: 'codex:stolen' })),
      (err: unknown) => err instanceof HubError && err.status === 400
    );
  });
});

describe('reply routing', () => {
  it('Codex replies to Grok on the originating thread (reply_to), not to from', async () => {
    const { hub, adapters, grok, codex } = setup();
    const original = await hub.send(
      grok,
      payload({
        to: 'codex:y',
        from: 'grok:other',
        reply_to: 'grok:origin',
        correlation_id: 'job-1',
      })
    );

    const reply = await hub.send(
      codex,
      payload({
        to: 'grok:ignored',
        from_thread: 'y',
        in_reply_to: original.id,
        type: 'reply',
      })
    );

    assert.equal(reply.to, 'grok:origin');
    assert.equal(reply.from, 'codex:y');
    assert.equal(reply.reply_to, 'codex:y');
    assert.equal(reply.correlation_id, 'job-1');
    assert.equal(reply.in_reply_to, original.id);

    const grokStub = adapters.get('grok') as StubAdapter;
    const last = grokStub.sent.at(-1);
    assert.equal(last?.threadId, 'origin');
    assert.deepEqual(last?.envelope.to, { vendor: 'grok', thread_id: 'origin' });
  });

  it('falls back to from when the original has no reply_to', async () => {
    const { hub, adapters, store, codex } = setup();
    const original = store.send('grok:x', {
      to: 'codex:y',
      thread: 't',
      subject: 's',
      body: 'q',
      type: 'message',
    });
    const reply = await hub.send(
      codex,
      payload({ to: 'claude:nope', from_thread: 'y', in_reply_to: original.id, type: 'reply' })
    );
    assert.equal(reply.to, 'grok:x');
    assert.equal((adapters.get('grok') as StubAdapter).sent.at(-1)?.threadId, 'x');
  });
});

describe('listen / ack', () => {
  it('long-polls the vendor inbox the same way GET /v1/inbox does', async () => {
    const { hub, grok, codex } = setup();
    const pending = hub.listen('codex', 0, 2_000);
    setTimeout(() => {
      void hub.send(grok, payload({ to: 'codex:y', from_thread: 'x' }));
    }, 20);
    const messages = await pending;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.to, 'codex:y');
    // Cursor ack: the next listen at that seq sees nothing new.
    assert.deepEqual(await hub.listenAs(codex, messages[0]!.seq, 20), []);
  });
});
