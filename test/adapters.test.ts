import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { Server } from 'node:http';

import { CursorAdapter } from '../src/adapters/cursor.js';
import { GrokAdapter, extractXaiText } from '../src/adapters/grok.js';
import { formatForThread, parseFormatted, replyToFromRefs, refsWithReplyTo } from '../src/adapters/format.js';
import { envelopeFromMailbox, mailboxTarget } from '../src/adapters/bridge.js';
import { AdapterHub, envelopeFromSendBody } from '../src/adapters/hub.js';
import { createAdapterServer } from '../src/adapters/server.js';
import {
  createEnvelope,
  formatAddress,
  parseAddress,
  replyEnvelope,
  type Envelope,
  type ReceiveResult,
  type SendResult,
  type VendorAdapter,
} from '../src/adapters/protocol.js';
import type { Message } from '../src/types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => handler(String(input), init);
}

const mail = (over: Partial<Envelope> = {}): Envelope =>
  createEnvelope({
    from: 'grok:resp_src',
    to: 'cursor:bc-dest',
    reply_to: 'grok:resp_src',
    body: 'please look at this',
    correlation_id: 'corr-1',
    ...over,
  });

describe('adapter protocol', () => {
  it('parses vendor:thread_id on the first colon', () => {
    assert.deepEqual(parseAddress('cursor:bc-abc:extra'), {
      vendor: 'cursor',
      threadId: 'bc-abc:extra',
    });
    assert.equal(formatAddress('grok', 'resp_1'), 'grok:resp_1');
    assert.throws(() => parseAddress('nocolon'));
  });

  it('defaults reply_to to the sender so replies have somewhere to land', () => {
    const env = createEnvelope({ from: 'cursor:bc-1', to: 'grok:resp_2', body: 'hi' });
    assert.equal(env.reply_to, 'cursor:bc-1');
    const reply = replyEnvelope(env, 'pong', 'grok:resp_2');
    assert.equal(reply.to, 'cursor:bc-1');
    assert.equal(reply.reply_to, 'cursor:bc-1');
    assert.equal(reply.correlation_id, env.correlation_id);
  });

  it('round-trips the pasted mailbox block', () => {
    const env = mail();
    const parsed = parseFormatted(formatForThread(env));
    assert.ok(parsed);
    assert.equal(parsed.from, env.from);
    assert.equal(parsed.to, env.to);
    assert.equal(parsed.reply_to, env.reply_to);
    assert.equal(parsed.body, env.body);
  });

  it('stores reply_to in mailbox refs without forking the hub schema', () => {
    assert.equal(replyToFromRefs(refsWithReplyTo('cursor:bc-9')), 'cursor:bc-9');
  });
});

describe('Cursor Cloud Agents', () => {
  it('follow-ups a bc-* thread and returns the run result to reply_to', async () => {
    const calls: string[] = [];
    const adapter = new CursorAdapter({
      apiKey: 'test-key',
      platform: 'linux',
      busyRetries: 0,
      fetch: mockFetch((url, init) => {
        const path = new URL(url).pathname;
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push(`${method} ${path}`);
        if (method === 'POST' && path.endsWith('/runs')) {
          return jsonResponse({ run: { id: 'run-99', status: 'CREATING' } });
        }
        if (path.endsWith('/conversation')) {
          return jsonResponse({
            messages: [
              { id: 'm1', type: 'user_message', text: 'please look at this' },
              { id: 'm2', type: 'assistant_message', text: 'looked; all good' },
            ],
          });
        }
        return jsonResponse({ error: 'nope' }, 404);
      }),
    });

    const outbound = mail({ to: 'cursor:bc-dest', from: 'grok:resp_src', reply_to: 'grok:resp_src' });
    const sent = await adapter.send('bc-dest', outbound);
    assert.equal(sent.transport, 'cloud');
    assert.equal(sent.nativeId, 'run-99');
    assert.ok(calls.some((c) => c.startsWith('POST ')));

    const received = await adapter.receive('bc-dest');
    assert.equal(received.envelopes.length, 1);
    assert.equal(received.envelopes[0]!.to, 'grok:resp_src');
    assert.equal(received.envelopes[0]!.from, 'cursor:bc-dest');
    assert.equal(received.envelopes[0]!.body, 'looked; all good');
    assert.equal(received.envelopes[0]!.correlation_id, outbound.correlation_id);
  });

  it('retries a 409 agent_busy follow-up', async () => {
    let posts = 0;
    const adapter = new CursorAdapter({
      apiKey: 'k',
      platform: 'linux',
      busyRetries: 2,
      sleep: async () => undefined,
      fetch: mockFetch((url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          posts += 1;
          if (posts === 1) return jsonResponse({ error: 'busy' }, 409);
          return jsonResponse({ run: { id: 'run-ok' } });
        }
        return jsonResponse({}, 404);
      }),
    });
    const sent = await adapter.send('bc-1', mail({ to: 'cursor:bc-1' }));
    assert.equal(sent.nativeId, 'run-ok');
    assert.equal(posts, 2);
  });

  it('refuses desktop injection on Linux when no API key or CLI is available', async () => {
    const adapter = new CursorAdapter({
      platform: 'linux',
      agentBin: 'no-such-cursor-agent-bin',
      runCommand: async () => ({ code: 1, stdout: '', stderr: '' }),
    });
    await assert.rejects(
      () => adapter.send('local-thread', mail({ to: 'cursor:local-thread' })),
      /needs macOS/u
    );
  });
});

describe('Grok / xAI', () => {
  it('continues a Responses API thread and routes the model text to reply_to', async () => {
    const adapter = new GrokAdapter({
      apiKey: 'xai-test',
      model: 'grok-4.6',
      platform: 'linux',
      fetch: mockFetch((url, init) => {
        if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { previous_response_id?: string };
          assert.equal(body.previous_response_id, 'resp_src');
          return jsonResponse({
            id: 'resp_next',
            output_text: 'done from grok',
          });
        }
        return jsonResponse({ id: 'resp_next', output_text: 'done from grok' });
      }),
    });

    const outbound = mail({
      from: 'cursor:bc-1',
      to: 'grok:resp_src',
      reply_to: 'cursor:bc-1',
      body: 'summarise',
    });
    const sent = await adapter.send('resp_src', outbound);
    assert.equal(sent.transport, 'xai');
    assert.equal(sent.nativeId, 'resp_next');

    const received = await adapter.receive('resp_src');
    assert.equal(received.envelopes.length, 1);
    assert.equal(received.envelopes[0]!.to, 'cursor:bc-1');
    assert.equal(received.envelopes[0]!.from, 'grok:resp_src');
    assert.equal(received.envelopes[0]!.body, 'done from grok');
  });

  it('does not treat a grok.com UUID as an xAI response id', async () => {
    const adapter = new GrokAdapter({ apiKey: 'xai-test', platform: 'linux' });
    await assert.rejects(
      () =>
        adapter.send(
          '2eabb92a-7a38-4974-a2e5-22ac1fb574ce',
          mail({ to: 'grok:2eabb92a-7a38-4974-a2e5-22ac1fb574ce' })
        ),
      /needs macOS/u
    );
  });

  it('pulls output_text out of the Responses payload shapes', () => {
    assert.equal(extractXaiText({ output_text: 'plain' }), 'plain');
    assert.equal(
      extractXaiText({
        output: [{ content: [{ type: 'output_text', text: 'nested' }] }],
      }),
      'nested'
    );
  });
});

describe('n-to-n bounce', () => {
  it('injects a grok reply back into the cursor thread named in reply_to', async () => {
    const delivered: Envelope[] = [];
    const cursor: VendorAdapter = {
      vendor: 'cursor',
      async send(_threadId, envelope) {
        delivered.push(envelope);
        return { envelope, transport: 'fake', nativeId: 'c' };
      },
      async receive() {
        return { envelopes: [], cursor: '0' };
      },
    };
    const grok: VendorAdapter = {
      vendor: 'grok',
      async send(_threadId, envelope) {
        return { envelope, transport: 'fake', nativeId: 'g' };
      },
      async receive() {
        return {
          envelopes: [
            replyEnvelope(
              mail({ from: 'cursor:bc-1', to: 'grok:resp_1', reply_to: 'cursor:bc-1' }),
              'here is grok',
              'grok:resp_1'
            ),
          ],
          cursor: '1',
        };
      },
    };
    const hub = new AdapterHub().register(cursor).register(grok);
    const received = await hub.receive('grok:resp_1');
    const bounced = await hub.deliverIfLocal(received.envelopes[0]!);
    assert.ok(bounced);
    assert.equal(delivered[0]!.to, 'cursor:bc-1');
    assert.equal(delivered[0]!.body, 'here is grok');
  });
});

describe('adapter HTTP', () => {
  class FakeCursor implements VendorAdapter {
    readonly vendor = 'cursor' as const;
    last: Envelope | undefined;
    async send(_threadId: string, envelope: Envelope): Promise<SendResult> {
      this.last = envelope;
      return { envelope, transport: 'fake', nativeId: 'n1' };
    }
    async receive(): Promise<ReceiveResult> {
      if (!this.last) return { envelopes: [], cursor: '0' };
      return {
        envelopes: [replyEnvelope(this.last, 'ack from cursor', 'cursor:bc-9')],
        cursor: '1',
      };
    }
  }

  const fake = new FakeCursor();
  const hub = new AdapterHub().register(fake);
  let server: Server;
  let base = '';

  it('accepts an envelope and serves the reply on receive', async () => {
    server = createAdapterServer(hub);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sent = await fetch(`${base}/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'grok:resp_1',
        to: 'cursor:bc-9',
        reply_to: 'grok:resp_1',
        body: 'hello cursor',
      }),
    });
    assert.equal(sent.status, 201);
    const sentBody = (await sent.json()) as { to: string; transport: string };
    assert.equal(sentBody.to, 'cursor:bc-9');
    assert.equal(sentBody.transport, 'fake');

    const received = await fetch(`${base}/v1/receive?address=cursor:bc-9`);
    const payload = (await received.json()) as { data: Envelope[] };
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0]!.to, 'grok:resp_1');
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('mailbox mapping', () => {
  it('turns a hub message into vendor:thread addressing', () => {
    const message: Message = {
      id: 'id-1',
      seq: 3,
      thread: 'bc-xyz',
      from: 'alice',
      to: 'cursor',
      type: 'message',
      subject: 's',
      body: 'hello',
      ts: '2026-09-11T00:00:00.000Z',
      refs: ['reply_to:alice:handshake'],
    };
    const env = envelopeFromMailbox(message, 'cursor');
    assert.equal(env.to, 'cursor:bc-xyz');
    assert.equal(env.from, 'alice:bc-xyz');
    assert.equal(env.reply_to, 'alice:handshake');
    assert.deepEqual(mailboxTarget(env.reply_to), { to: 'alice', thread: 'handshake' });
  });

  it('requires from/to/body on the adapter HTTP body', () => {
    assert.throws(() => envelopeFromSendBody({ to: 'cursor:x' }), /from, to and body/u);
  });
});
