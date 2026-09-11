import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CodexAdapter, lastAssistantFromJsonl } from '../src/adapters/codex.js';
import { addr } from '../src/adapters/format.js';
import type { RunCommand } from '../src/adapters/run.js';
import type { MacDriver } from '../src/adapters/mac.js';
import { AdapterRegistry } from '../src/adapter.js';
import type { Envelope } from '../src/protocol.js';

const envelope: Envelope = {
  id: 'm1',
  from: addr('claude', 'src'),
  to: addr('codex', '019d25ff-3701-75d1-b331-160b90f8a456'),
  reply_to: addr('claude', 'src'),
  body: 'please look at CI',
  created_at: '2026-09-11T00:00:00.000Z',
};

describe('codex adapter', () => {
  it('injects a live session with codex queue', async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (argv) => {
      calls.push(argv);
      if (argv[1] === 'queue') return { code: 0, stdout: 'queued\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'not reached' };
    };
    const adapter = new CodexAdapter({ run, platform: 'linux' });
    await adapter.send('019d25ff-3701-75d1-b331-160b90f8a456', envelope);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![1], 'queue');
    assert.equal(calls[0]![3], '019d25ff-3701-75d1-b331-160b90f8a456');
    assert.equal(calls[0]![4], '--message');
    assert.match(calls[0]![5]!, /please look at CI/u);
    assert.match(calls[0]![5]!, /reply_to: claude:src/u);
  });

  it('falls back to exec resume and emits the captured reply', async () => {
    const run: RunCommand = async (argv) => {
      if (argv[1] === 'queue') {
        return { code: 1, stdout: '', stderr: 'unknown command queue' };
      }
      if (argv[1] === 'exec' && argv[2] === 'resume') {
        const out = argv[argv.indexOf('--output-last-message') + 1]!;
        writeFileSync(out, 'tests are green');
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: argv.join(' ') };
    };
    const adapter = new CodexAdapter({ run, platform: 'linux' });
    const replies: string[] = [];
    const stop = adapter.listen('sess-1', (body) => {
      replies.push(body);
    });
    await adapter.send('sess-1', envelope);
    stop();
    assert.deepEqual(replies, ['tests are green']);
  });

  it('opens the Codex deep link on macOS when CLI inject fails', async () => {
    const opens: string[] = [];
    const mac: MacDriver = {
      platform: 'darwin',
      openUrl: async (url) => {
        opens.push(url);
      },
      copy: async () => undefined,
      pasteAndSubmit: async () => undefined,
      readVisibleText: async () => '',
    };
    const run: RunCommand = async () => ({ code: 1, stdout: '', stderr: 'no cli' });
    const adapter = new CodexAdapter({ run, mac, platform: 'darwin' });
    await adapter.send('019d25ff-3701-75d1-b331-160b90f8a456', envelope);
    assert.equal(opens[0], 'codex://threads/019d25ff-3701-75d1-b331-160b90f8a456');
  });

  it('parses assistant text out of JSONL events', () => {
    const jsonl = [
      '{"type":"thread.started"}',
      '{"item":{"type":"agent_message","text":"first"}}',
      '{"finalResponse":"second"}',
    ].join('\n');
    assert.equal(lastAssistantFromJsonl(jsonl), 'second');
  });

  it('registers on the hub AdapterRegistry as vendor codex', async () => {
    const run: RunCommand = async (argv) => {
      if (argv[1] === 'queue') return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'no' };
    };
    const registry = AdapterRegistry.withStubs();
    registry.register(new CodexAdapter({ run, platform: 'linux' }));
    await registry.deliver('sess', envelope);
    assert.equal(registry.get('codex') instanceof CodexAdapter, true);
  });
});
