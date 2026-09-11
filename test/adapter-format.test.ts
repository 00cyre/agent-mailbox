import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatReplyDestination, replyDestination, type Envelope } from '../src/protocol.js';
import {
  addr,
  envelopeFromHubMessage,
  envelopeRefs,
  renderInbound,
  replyEnvelope,
  REF_REPLY_TO,
} from '../src/adapters/format.js';

const sample: Envelope = {
  id: 'mid',
  from: addr('cursor', '1'),
  to: addr('codex', '2'),
  reply_to: addr('cursor', '1'),
  correlation_id: 'corr',
  body: 'please review the diff',
  created_at: '2026-09-11T00:00:00.000Z',
};

describe('adapter envelope helpers', () => {
  it('renders inbound text without turning the body into instructions', () => {
    const text = renderInbound(sample);
    assert.match(text, /^\[agent-mailbox\]/u);
    assert.match(text, /from: cursor:1/u);
    assert.match(text, /reply_to: cursor:1/u);
    assert.match(text, /please review the diff/u);
    assert.doesNotMatch(text, /you must/iu);
  });

  it('routes a native reply to reply_to and sets reply_to to this thread', () => {
    const inbound: Envelope = {
      id: 'in',
      from: addr('claude', 'x'),
      to: addr('codex', 'y'),
      reply_to: addr('claude', 'x'),
      body: 'ping',
      created_at: '2026-09-11T00:00:00.000Z',
    };
    const outbound = replyEnvelope(inbound, 'pong', addr('codex', 'y'));
    assert.deepEqual(outbound.to, addr('claude', 'x'));
    assert.deepEqual(outbound.from, addr('codex', 'y'));
    assert.deepEqual(outbound.reply_to, addr('codex', 'y'));
    assert.equal(outbound.body, 'pong');
  });

  it('uses from when reply_to is omitted', () => {
    assert.deepEqual(replyDestination({ from: addr('grok', 'x') }), addr('grok', 'x'));
    assert.equal(formatReplyDestination({ from: 'grok:x', reply_to: 'claude:y' }), 'claude:y');
  });

  it('round-trips reply_to through hub refs', () => {
    const envelope: Envelope = {
      id: 'e1',
      from: addr('grok', 'bot'),
      to: addr('chatgpt', 'conv'),
      reply_to: addr('claude', 'origin'),
      correlation_id: 'job-9',
      body: 'hi',
      created_at: '2026-09-11T00:00:00.000Z',
    };
    const refs = envelopeRefs(envelope);
    assert.ok(refs.some((r) => r === `${REF_REPLY_TO}claude:origin`));
    const recovered = envelopeFromHubMessage(
      {
        id: envelope.id,
        from: 'grokbot',
        to: 'chatgpt-conv',
        body: 'hi',
        thread: 'other',
        refs,
        ts: envelope.created_at,
      },
      addr('chatgpt', 'conv')
    );
    assert.deepEqual(recovered.reply_to, addr('claude', 'origin'));
    assert.equal(recovered.correlation_id, 'job-9');
    assert.deepEqual(recovered.to, addr('chatgpt', 'conv'));
  });
});
