import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MailStore } from '../src/store.js';

const dirs: string[] = [];
function freshStore(): MailStore {
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-'));
  dirs.push(dir);
  return new MailStore({ dir });
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const note = (to: string, thread = 't') => ({
  to,
  thread,
  subject: 's',
  body: 'b',
  type: 'message' as const,
});

describe('addressing', () => {
  it('delivers to the named recipient and nobody else', () => {
    const store = freshStore();
    store.send('alice', note('bob'));
    assert.equal(store.since('bob', 0).length, 1);
    assert.equal(store.since('carol', 0).length, 0);
  });

  it('delivers a broadcast to everyone but its sender', () => {
    const store = freshStore();
    store.send('alice', note('*'));
    assert.equal(store.since('bob', 0).length, 1);
    assert.equal(store.since('carol', 0).length, 1);
    // Otherwise a broadcaster's own wait_for_message returns its own message
    // and every agent ends up in a loop talking to itself.
    assert.equal(store.since('alice', 0).length, 0);
  });
});

describe('cursor', () => {
  it('returns each message exactly once across successive reads', () => {
    const store = freshStore();
    store.send('alice', note('bob'));
    const first = store.since('bob', 0);
    assert.equal(first.length, 1);

    const cursor = first[0]!.seq;
    assert.deepEqual(store.since('bob', cursor), []);

    store.send('alice', note('bob'));
    const second = store.since('bob', cursor);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.seq, cursor + 1);
  });

  it('orders by seq even when timestamps collide', () => {
    const store = freshStore();
    for (let i = 0; i < 50; i += 1) store.send('alice', note('bob'));
    const seqs = store.since('bob', 0).map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, 50);
  });
});

describe('long poll', () => {
  it('resolves the moment a message arrives, not at the timeout', async () => {
    const store = freshStore();
    const started = Date.now();
    const pending = store.wait('bob', store.head, 10_000);
    setTimeout(() => store.send('alice', note('bob')), 20);

    const messages = await pending;
    assert.equal(messages.length, 1);
    // The whole point of the hub over a polled folder: latency is the hop.
    assert.ok(Date.now() - started < 2_000, 'wait should return on delivery, not on timeout');
  });

  it('returns empty at the timeout rather than throwing', async () => {
    const store = freshStore();
    assert.deepEqual(await store.wait('bob', store.head, 30), []);
  });

  it('does not wake a waiter for another agent', async () => {
    const store = freshStore();
    const pending = store.wait('carol', store.head, 120);
    store.send('alice', note('bob'));
    assert.deepEqual(await pending, []);
  });

  it('honours a thread filter', async () => {
    const store = freshStore();
    const pending = store.wait('bob', store.head, 2_000, 'wanted');
    store.send('alice', note('bob', 'ignored'));
    setTimeout(() => store.send('alice', note('bob', 'wanted')), 20);
    const messages = await pending;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.thread, 'wanted');
  });
});

describe('durability', () => {
  it('reloads messages and the seq counter from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailbox-'));
    dirs.push(dir);

    const first = new MailStore({ dir });
    first.send('alice', note('bob'));
    first.send('alice', note('bob'));
    first.close();

    const second = new MailStore({ dir });
    assert.equal(second.since('bob', 0).length, 2);
    // A restart that reset the counter would reissue seqs a reader has already
    // passed, and those messages would never be delivered.
    assert.equal(second.head, 2);
    const next = second.send('alice', note('bob'));
    assert.equal(next.seq, 3);
  });
});

describe('threads', () => {
  it('shows both directions of a conversation', () => {
    const store = freshStore();
    store.send('alice', note('bob', 'chat'));
    store.send('bob', note('alice', 'chat'));
    assert.equal(store.thread('alice', 'chat').length, 2);
    assert.equal(store.thread('bob', 'chat').length, 2);
  });

  it('delivers vendor:thread mail to a vendor inbox, not the sender\'s', () => {
    const store = freshStore();
    store.send('grok:x', {
      to: 'codex:y',
      thread: 't',
      subject: 's',
      body: 'b',
      type: 'message',
    });
    assert.equal(store.since('codex', 0).length, 1);
    assert.equal(store.since('grok', 0).length, 0);
    assert.equal(store.since('alice', 0).length, 0);
  });

  it('lists threads by most recent activity', () => {
    const store = freshStore();
    store.send('alice', note('bob', 'old'));
    store.send('alice', note('bob', 'new'));
    assert.deepEqual(
      store.threads('bob').map((t) => t.thread),
      ['new', 'old']
    );
  });
});
