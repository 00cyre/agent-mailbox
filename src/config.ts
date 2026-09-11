import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Agent } from './types.js';
import { AGENT_ID } from './types.js';

/**
 * Who may use this mailbox, and how the server proves it.
 *
 * Tokens are stored hashed and compared in constant time. That is not
 * ceremony: this file is the only thing between a public URL and an agent
 * impersonating another, and `===` on a secret leaks its prefix through timing.
 */

export interface MailboxConfig {
  port: number;
  host: string;
  dataDir: string;
  agents: Agent[];
}

export interface ConfigFile {
  port?: number;
  host?: string;
  dataDir?: string;
  agents: { id: string; token: string; description?: string; canSend?: boolean; disabled?: boolean }[];
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_CONFIG_PATH = 'mailbox.config.json';

/** `mb_<agent>_<random>` — a stray token says which mailbox and which agent it belongs to. */
export function generateToken(agentId: string): string {
  return `mb_${agentId}_${randomBytes(24).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): MailboxConfig {
  const full = resolve(path);
  if (!existsSync(full)) {
    throw new Error(
      `no config at ${full}. Run \`agent-mailbox init\` to create one, or pass --config <path>.`
    );
  }
  const parsed = JSON.parse(readFileSync(full, 'utf8')) as ConfigFile;
  if (!Array.isArray(parsed.agents) || parsed.agents.length === 0) {
    throw new Error(`${full} lists no agents; a mailbox with no agents accepts nobody`);
  }

  const agents: Agent[] = parsed.agents.map((entry) => {
    if (!AGENT_ID.test(entry.id)) {
      throw new Error(`invalid agent id ${JSON.stringify(entry.id)} in ${full}`);
    }
    if (!entry.token || entry.token.length < 16) {
      throw new Error(`agent "${entry.id}" has no usable token in ${full}`);
    }
    return {
      id: entry.id,
      tokenHash: hashToken(entry.token),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.canSend !== undefined ? { canSend: entry.canSend } : {}),
      ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
    };
  });

  const ids = new Set(agents.map((a) => a.id));
  if (ids.size !== agents.length) throw new Error(`${full} has duplicate agent ids`);

  return {
    port: Number(process.env['MAILBOX_PORT'] ?? parsed.port ?? DEFAULT_PORT),
    host: process.env['MAILBOX_HOST'] ?? parsed.host ?? '127.0.0.1',
    dataDir: resolve(process.env['MAILBOX_DATA'] ?? parsed.dataDir ?? 'data'),
    agents,
  };
}

/** Write a starter config with freshly minted tokens, and return them once. */
export function initConfig(
  path: string,
  agentIds: string[]
): { path: string; tokens: { id: string; token: string }[] } {
  const full = resolve(path);
  if (existsSync(full)) throw new Error(`${full} already exists; refusing to overwrite tokens`);

  const tokens = agentIds.map((id) => {
    if (!AGENT_ID.test(id)) throw new Error(`invalid agent id ${JSON.stringify(id)}`);
    return { id, token: generateToken(id) };
  });

  const file: ConfigFile = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    dataDir: 'data',
    agents: tokens.map(({ id, token }) => ({ id, token })),
  };

  writeFileSync(full, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  // The file holds every token in plaintext; it is the one secret this package has.
  chmodSync(full, 0o600);
  return { path: full, tokens };
}

export class AgentRegistry {
  readonly #byHash = new Map<string, Agent>();
  readonly #byId = new Map<string, Agent>();

  constructor(agents: Agent[]) {
    for (const agent of agents) {
      this.#byHash.set(agent.tokenHash, agent);
      this.#byId.set(agent.id, agent);
    }
  }

  /** Token -> agent, constant time, or undefined. */
  authenticate(token: string | undefined): Agent | undefined {
    if (!token) return undefined;
    const hash = hashToken(token);
    const candidate = this.#byHash.get(hash);
    if (!candidate || candidate.disabled) return undefined;
    // The map lookup already decided it; this re-check keeps the comparison
    // constant-time against a hash that collides in the map's bucket.
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(candidate.tokenHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    return candidate;
  }

  get(id: string): Agent | undefined {
    return this.#byId.get(id);
  }

  list(): Agent[] {
    return [...this.#byId.values()].filter((a) => !a.disabled);
  }

  has(id: string): boolean {
    const agent = this.#byId.get(id);
    return agent !== undefined && !agent.disabled;
  }
}
