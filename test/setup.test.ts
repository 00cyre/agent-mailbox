import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initConfig } from '../src/config.js';
import { CATALOGUE, parseSelection } from '../src/wizard.js';
import { installedArgs, CONFIG } from '../src/service.js';

describe('agent menu', () => {
  it('takes numbers off the list', () => {
    assert.deepEqual(parseSelection('1,3', CATALOGUE), ['claude', 'codex']);
  });

  it('treats an empty answer as everything', () => {
    assert.deepEqual(parseSelection('', CATALOGUE), CATALOGUE.map((a) => a.id));
  });

  it('accepts a name the catalogue never heard of', () => {
    // The catalogue is a starting point; the package cannot know what comes next.
    assert.deepEqual(parseSelection('1, my-own-bot', CATALOGUE), ['claude', 'my-own-bot']);
  });

  it('does not create the same agent twice', () => {
    assert.deepEqual(parseSelection('1,1,claude', CATALOGUE), ['claude']);
  });

  it('refuses an id that would not be addressable', () => {
    assert.throws(() => parseSelection('Not An Id!', CATALOGUE), /not a number|valid agent id/u);
  });
});

describe('init', () => {
  const withDir = (run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'mb-init-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('marks the chosen agent as the relay, and only that one', () => {
    withDir((dir) => {
      const path = join(dir, 'mailbox.config.json');
      initConfig(path, ['claude', 'grokbot'], { relay: 'claude', port: 9001 });
      const file = JSON.parse(readFileSync(path, 'utf8')) as {
        port: number;
        agents: { id: string; relay?: boolean }[];
      };
      assert.equal(file.port, 9001);
      assert.equal(file.agents.find((a) => a.id === 'claude')?.relay, true);
      assert.equal(file.agents.find((a) => a.id === 'grokbot')?.relay, undefined);
    });
  });

  it('refuses a relay that is not one of the agents', () => {
    withDir((dir) => {
      assert.throws(
        () => initConfig(join(dir, 'c.json'), ['claude'], { relay: 'nobody' }),
        /relay "nobody" is not one of the agents/u
      );
    });
  });

  it('still writes tokens only the owner can read', () => {
    withDir((dir) => {
      const path = join(dir, 'mailbox.config.json');
      initConfig(path, ['claude'], { relay: 'claude' });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    });
  });
});

describe('service', () => {
  it('points the supervisor at an absolute cli and config, never at cwd', () => {
    // launchd starts the job with cwd `/`, and an npx copy lives in a cache
    // npm may delete. A relative path here is a service that breaks untouched.
    const args = installedArgs();
    assert.match(args[0]!, /^\//u);
    assert.equal(args[1], 'serve');
    assert.equal(args[3], CONFIG);
    assert.match(CONFIG, /^\//u);
  });
});
