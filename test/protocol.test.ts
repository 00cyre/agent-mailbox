import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatAddress,
  formatReplyDestination,
  inferVendor,
  parseAddress,
  replyDestination,
  toEnvelope,
} from '../src/protocol.js';

describe('parseAddress', () => {
  it('reads vendor:thread_id, including colons inside the thread id', () => {
    assert.deepEqual(parseAddress('grok:abc'), { vendor: 'grok', thread_id: 'abc' });
    assert.deepEqual(parseAddress('claude:session:xyz'), { vendor: 'claude', thread_id: 'session:xyz' });
    assert.deepEqual(parseAddress('codex:bc-1eca-uuid'), { vendor: 'codex', thread_id: 'bc-1eca-uuid' });
  });

  it('rejects agent ids, chat names, broadcasts, and whitespace thread ids', () => {
    assert.equal(parseAddress('grokbot'), undefined);
    assert.equal(parseAddress('Project status check'), undefined);
    assert.equal(parseAddress('*'), undefined);
    assert.equal(parseAddress('grok:has space'), undefined);
    assert.equal(parseAddress(':missing'), undefined);
    assert.equal(parseAddress('GROK:Abc')?.vendor, 'grok');
  });
});

describe('replyDestination', () => {
  it('prefers reply_to over from', () => {
    assert.deepEqual(
      replyDestination({
        from: { vendor: 'grok', thread_id: 'x' },
        reply_to: { vendor: 'grok', thread_id: 'origin' },
      }),
      { vendor: 'grok', thread_id: 'origin' }
    );
    assert.equal(formatReplyDestination({ from: 'grok:x', reply_to: 'grok:origin' }), 'grok:origin');
  });

  it('falls back to from when reply_to is absent', () => {
    assert.equal(replyDestination({ from: 'codex:y' }), 'codex:y');
    assert.equal(formatReplyDestination({ from: 'alice' }), 'alice');
  });
});

describe('inferVendor', () => {
  it('uses an explicit vendor, then a known id, then an alias', () => {
    assert.equal(inferVendor('grokbot', 'grok'), 'grok');
    assert.equal(inferVendor('claude'), 'claude');
    assert.equal(inferVendor('grokbot'), 'grok');
    assert.equal(inferVendor('alice'), undefined);
  });
});

describe('toEnvelope', () => {
  it('maps a stored message onto the adapter envelope', () => {
    const envelope = toEnvelope({
      id: '1',
      from: 'grok:x',
      to: 'codex:y',
      reply_to: 'grok:x',
      correlation_id: 'c1',
      body: 'hi',
      ts: '2026-09-11T00:00:00.000Z',
    });
    assert.deepEqual(envelope, {
      id: '1',
      from: { vendor: 'grok', thread_id: 'x' },
      to: { vendor: 'codex', thread_id: 'y' },
      reply_to: { vendor: 'grok', thread_id: 'x' },
      correlation_id: 'c1',
      body: 'hi',
      created_at: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(formatAddress(envelope!.from), 'grok:x');
  });

  it('returns undefined when from or to is not an address', () => {
    assert.equal(
      toEnvelope({
        id: '1',
        from: 'alice',
        to: 'bob',
        body: 'hi',
        ts: '2026-09-11T00:00:00.000Z',
      }),
      undefined
    );
  });
});
