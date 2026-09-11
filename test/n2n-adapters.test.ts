import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AdapterRegistry } from '../src/adapter.js';
import { AgentRegistry, hashToken } from '../src/config.js';
import { MailboxHub } from '../src/hub.js';
import { MailStore } from '../src/store.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GrokAdapter } from '../src/adapters/grok.js';
import { ClaudeAdapter } from '../src/adapters/claude/adapter.js';
import { CursorAdapter } from '../src/adapters/cursor.js';
import { ChatGptAdapter } from '../src/adapters/chatgpt.js';
import { registerOpenaiAdapters, registerClaudeAdapter, registerCursorGrokAdapters } from '../src/adapters/index.js';
import type { RunCommand } from '../src/adapters/run.js';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('wired vendor adapters', () => {
  it('routes grok:X → codex:Y through CodexAdapter, and the reply back to grok:X', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailbox-n2n-'));
    dirs.push(dir);
    const store = new MailStore({ dir });
    const agents = new AgentRegistry([
      { id: 'grok', tokenHash: hashToken('mb_grok_testtoken00000000'), vendor: 'grok' },
      { id: 'codex', tokenHash: hashToken('mb_codex_testtoken0000000'), vendor: 'codex' },
    ]);

    const grokCalls: string[] = [];
    const grok = new GrokAdapter({
      apiKey: 'xai-test',
      platform: 'linux',
      fetch: async (input, init) => {
        grokCalls.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`);
        return jsonResponse({ id: 'resp_next', output_text: 'rendered on grok' });
      },
    });

    const codexThreads: string[] = [];
    const run: RunCommand = async (argv) => {
      if (argv[1] === 'queue') {
        codexThreads.push(argv[3] ?? '');
        return { code: 0, stdout: 'queued\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: argv.join(' ') };
    };
    const codex = new CodexAdapter({ run, platform: 'linux' });

    const adapters = new AdapterRegistry();
    adapters.register(grok);
    adapters.register(codex);
    const hub = new MailboxHub({ store, agents, adapters });

    const outbound = await hub.send(agents.get('grok')!, {
      to: 'codex:session-y',
      from_thread: 'resp_x',
      body: 'please render this',
      type: 'message',
      correlation_id: 'job-xy',
    });
    assert.equal(outbound.from, 'grok:resp_x');
    assert.equal(outbound.to, 'codex:session-y');
    assert.equal(outbound.reply_to, 'grok:resp_x');
    assert.deepEqual(codexThreads, ['session-y']);

    const reply = await hub.send(agents.get('codex')!, {
      to: 'claude:ignored',
      from_thread: 'session-y',
      in_reply_to: outbound.id,
      type: 'reply',
      body: 'rendered',
    });
    assert.equal(reply.to, 'grok:resp_x');
    assert.equal(reply.from, 'codex:session-y');
    assert.ok(grokCalls.some((c) => c.startsWith('POST ')));
  });

  it('routes the reverse: codex:Y → grok:X, reply lands on Y', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailbox-n2n-rev-'));
    dirs.push(dir);
    const store = new MailStore({ dir });
    const agents = new AgentRegistry([
      { id: 'grok', tokenHash: hashToken('mb_grok_testtoken00000000'), vendor: 'grok' },
      { id: 'codex', tokenHash: hashToken('mb_codex_testtoken0000000'), vendor: 'codex' },
    ]);

    const grok = new GrokAdapter({
      apiKey: 'xai-test',
      platform: 'linux',
      fetch: async () => jsonResponse({ id: 'resp_ack', output_text: 'ack' }),
    });
    const run: RunCommand = async (argv) => {
      if (argv[1] === 'queue') return { code: 0, stdout: 'queued\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'no' };
    };
    const codex = new CodexAdapter({ run, platform: 'linux' });
    const adapters = new AdapterRegistry();
    adapters.register(grok);
    adapters.register(codex);
    const hub = new MailboxHub({ store, agents, adapters });

    const outbound = await hub.send(agents.get('codex')!, {
      to: 'grok:resp_x',
      from_thread: 'session-y',
      body: 'hello grok',
      type: 'message',
    });
    const reply = await hub.send(agents.get('grok')!, {
      to: 'ignored:nope',
      from_thread: 'resp_x',
      in_reply_to: outbound.id,
      type: 'reply',
      body: 'hi back',
    });
    assert.equal(reply.to, 'codex:session-y');
  });

  it('register* helpers replace hub stubs for every vendor', () => {
    const registry = AdapterRegistry.withStubs();
    registerClaudeAdapter(registry, { transports: ['listen'] });
    registerCursorGrokAdapters(registry, {
      cursor: { platform: 'linux' },
      grok: { platform: 'linux' },
    });
    registerOpenaiAdapters(registry, {
      codex: { platform: 'linux' },
      chatgpt: { platform: 'linux' },
    });
    assert.ok(registry.get('claude') instanceof ClaudeAdapter);
    assert.ok(registry.get('cursor') instanceof CursorAdapter);
    assert.ok(registry.get('grok') instanceof GrokAdapter);
    assert.ok(registry.get('codex') instanceof CodexAdapter);
    assert.ok(registry.get('chatgpt') instanceof ChatGptAdapter);
  });
});
