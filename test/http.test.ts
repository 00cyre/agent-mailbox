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

const ALICE = 'mb_alice_testtoken0000000000';
const BOB = 'mb_bob_testtoken00000000000';
const MUTE = 'mb_mute_testtoken0000000000';

let server: Server;
let base: string;
let dir: string;
let store: MailStore;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mailbox-http-'));
  store = new MailStore({ dir });
  const agents = new AgentRegistry([
    { id: 'alice', tokenHash: hashToken(ALICE) },
    { id: 'bob', tokenHash: hashToken(BOB), description: 'the other one' },
    { id: 'mute', tokenHash: hashToken(MUTE), canSend: false },
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
  token?: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const send = (token: string, body: unknown) =>
  call('/v1/send', token, { method: 'POST', body: JSON.stringify(body) });

describe('auth', () => {
  it('serves healthz without a token', async () => {
    const { status, body } = await call('/healthz');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('rejects every /v1 route without a token', async () => {
    for (const path of ['/v1/whoami', '/v1/agents', '/v1/inbox', '/v1/threads']) {
      assert.equal((await call(path)).status, 401, path);
    }
  });

  it('rejects an unknown token', async () => {
    assert.equal((await call('/v1/whoami', 'mb_alice_wrong')).status, 401);
  });

  it('identifies the caller from the token, not from the payload', async () => {
    // `from` is not a field a client can set; spoofing has to go through the
    // token or not at all.
    const sent = await send(ALICE, {
      to: 'bob',
      thread: 'spoof',
      subject: 's',
      body: 'b',
      from: 'bob',
    });
    assert.equal(sent.status, 400, 'unknown keys are rejected outright');

    const ok = await send(ALICE, { to: 'bob', thread: 'spoof', subject: 's', body: 'b' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.from, 'alice');
  });
});

describe('send', () => {
  it('refuses an unknown recipient rather than accepting an unreadable message', async () => {
    const { status, body } = await send(ALICE, {
      to: 'nobody',
      thread: 't',
      subject: 's',
      body: 'b',
    });
    assert.equal(status, 404);
    assert.match(body.error.message, /no agent "nobody"/u);
  });

  it('refuses a read-only agent', async () => {
    const { status } = await send(MUTE, { to: 'alice', thread: 't', subject: 's', body: 'b' });
    assert.equal(status, 403);
  });

  it('validates the payload', async () => {
    assert.equal((await send(ALICE, { to: 'bob' })).status, 400);
    assert.equal(
      (await send(ALICE, { to: 'bob', thread: 'Bad Slug!', subject: 's', body: 'b' })).status,
      400
    );
  });
});

describe('inbox', () => {
  it('long-polls and returns as soon as a message lands', async () => {
    const { body: who } = await call('/v1/whoami', BOB);
    const started = Date.now();
    const pending = call(`/v1/inbox?cursor=${who.head}&wait=10000`, BOB);
    setTimeout(() => void send(ALICE, { to: 'bob', thread: 'live', subject: 'hi', body: 'there' }), 30);

    const { status, body } = await pending;
    assert.equal(status, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].subject, 'hi');
    assert.ok(Date.now() - started < 3_000, 'should resolve on delivery, not at the timeout');
  });

  it('keeps the cursor unchanged on an empty poll', async () => {
    const { body: who } = await call('/v1/whoami', BOB);
    const { body } = await call(`/v1/inbox?cursor=${who.head}&wait=40`, BOB);
    assert.deepEqual(body.data, []);
    assert.equal(body.cursor, who.head);
  });

  it('does not leak another agent"s mail', async () => {
    await send(ALICE, { to: 'bob', thread: 'private', subject: 'for bob', body: 'b' });
    const { body } = await call('/v1/inbox?cursor=0&wait=0', MUTE);
    assert.deepEqual(
      body.data.filter((m: { thread: string }) => m.thread === 'private'),
      []
    );
  });
});

describe('routing', () => {
  it('404s an unknown route with a token', async () => {
    assert.equal((await call('/v1/nope', ALICE)).status, 404);
  });

  it('reports MCP as disabled when no handler is mounted', async () => {
    const { status, body } = await call('/mcp', ALICE, { method: 'POST', body: '{}' });
    assert.equal(status, 404);
    assert.match(body.error.message, /MCP is not enabled/u);
  });
});
