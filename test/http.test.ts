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
    assert.match(body.error.message, /no agent or chat "nobody"/u);
    // The error has to name the way out, or a sending agent's only recovery is
    // to guess.
    assert.match(body.error.message, /\/v1\/chats/u);
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

describe('chats', () => {
  const register = (token: string, name: string) =>
    call('/v1/chats', token, { method: 'POST', body: JSON.stringify({ name }) });

  it('claims a human-readable name and derives a slug', async () => {
    const { status, body } = await register(ALICE, 'Project status check (fork)');
    assert.equal(status, 201);
    assert.equal(body.slug, 'project-status-check-fork');
    assert.equal(body.name, 'Project status check (fork)');
    assert.equal(body.owner, 'alice');
  });

  it('is idempotent for the same owner, so a restarted listener just reconnects', async () => {
    await register(ALICE, 'Restart Me');
    const second = await register(ALICE, 'Restart Me');
    assert.equal(second.status, 201);
    assert.equal(second.body.slug, 'restart-me');
  });

  it('refuses a name another agent already owns', async () => {
    await register(ALICE, 'Mine');
    const { status } = await register(BOB, 'Mine');
    assert.equal(status, 409);
  });

  it('accepts the display name pasted verbatim as the address', async () => {
    await register(ALICE, 'Deploy Notes');
    // This is the whole use case: a human copies the chat name out of their
    // client and pastes it into another agent's prompt, spaces and all.
    const sent = await send(BOB, {
      to: 'Deploy Notes',
      thread: 'research',
      subject: 'done',
      body: 'finished the sweep',
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.to, 'deploy-notes');

    const { body } = await call('/v1/inbox?chat=deploy-notes&cursor=0&wait=0', ALICE);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].subject, 'done');
  });

  it('accepts the slug too, and matches case-insensitively', async () => {
    await register(ALICE, 'Case Test');
    for (const to of ['case-test', 'CASE TEST', 'Case  Test']) {
      assert.equal((await send(BOB, { to, thread: 't', subject: 's', body: 'b' })).status, 201, to);
    }
  });

  it('will not let another agent read a chat it does not own', async () => {
    await register(ALICE, 'Alice Only');
    const { status } = await call('/v1/inbox?chat=alice-only&cursor=0&wait=0', BOB);
    assert.equal(status, 403);
  });

  it('lists chats with a presence flag a sender can act on', async () => {
    await register(ALICE, 'Listed Chat');
    const { body } = await call('/v1/chats', BOB);
    const found = body.data.find((c: { slug: string }) => c.slug === 'listed-chat');
    assert.ok(found, 'a sender must be able to discover where to write');
    assert.equal(found.name, 'Listed Chat');
    assert.equal(typeof found.listening, 'boolean');
  });

  it('rejects a name with nothing addressable in it', async () => {
    const { status } = await register(ALICE, '!!! ???');
    assert.equal(status, 409);
  });

  it('delivers to a chat whose listener is away, for reading later', async () => {
    await register(ALICE, 'Away Chat');
    await send(BOB, { to: 'Away Chat', thread: 't', subject: 'queued', body: 'b' });
    // Nobody was polling. It is a mailbox, so the message waits.
    const { body } = await call('/v1/inbox?chat=away-chat&cursor=0&wait=0', ALICE);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].subject, 'queued');
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
