import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Envelope, SendResult } from '../protocol.js';
import { channelMeta, formatChannelContent } from './format.js';

export interface ChannelListener {
  threadId: string;
  url: string;
  pid: number;
  updated_at: string;
}

export interface ChannelState {
  listeners: Record<string, ChannelListener>;
}

export type ChannelNotify = (envelope: Envelope) => Promise<void>;

export function defaultStatePath(): string {
  return process.env['MAILBOX_CLAUDE_STATE'] ?? join(homedir(), '.agent-mailbox', 'claude-listeners.json');
}

export function loadChannelState(path: string): ChannelState {
  if (!existsSync(path)) return { listeners: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ChannelState;
    if (!parsed || typeof parsed !== 'object' || !parsed.listeners) return { listeners: {} };
    return parsed;
  } catch {
    return { listeners: {} };
  }
}

export function saveChannelState(path: string, state: ChannelState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function registerListener(path: string, listener: ChannelListener): void {
  const state = loadChannelState(path);
  state.listeners[listener.threadId] = listener;
  saveChannelState(path, state);
}

export function unregisterListener(path: string, threadId: string, pid: number): void {
  const state = loadChannelState(path);
  const current = state.listeners[threadId];
  if (current && current.pid === pid) delete state.listeners[threadId];
  saveChannelState(path, state);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function lookupListener(path: string, threadId: string): ChannelListener | undefined {
  const state = loadChannelState(path);
  const listener = state.listeners[threadId] ?? state.listeners['*'];
  if (!listener) return undefined;
  if (!pidAlive(listener.pid)) {
    delete state.listeners[listener.threadId];
    saveChannelState(path, state);
    return undefined;
  }
  return listener;
}

export class ChannelRegistry {
  readonly #byThread = new Map<string, ChannelNotify>();

  register(threadId: string, notify: ChannelNotify): void {
    this.#byThread.set(threadId, notify);
  }

  unregister(threadId: string): void {
    this.#byThread.delete(threadId);
  }

  get(threadId: string): ChannelNotify | undefined {
    return this.#byThread.get(threadId) ?? this.#byThread.get('*');
  }

  has(threadId: string): boolean {
    return this.#byThread.has(threadId) || this.#byThread.has('*');
  }
}

export interface ChannelHttpPost {
  (url: string, envelope: Envelope): Promise<void>;
}

export async function defaultChannelPost(url: string, envelope: Envelope): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`channel ${url} returned ${response.status}: ${text}`);
  }
}

export class ChannelTransport {
  readonly #registry: ChannelRegistry;
  readonly #statePath: string;
  readonly #post: ChannelHttpPost;

  constructor(options: {
    registry?: ChannelRegistry;
    statePath?: string;
    post?: ChannelHttpPost;
  } = {}) {
    this.#registry = options.registry ?? new ChannelRegistry();
    this.#statePath = options.statePath ?? defaultStatePath();
    this.#post = options.post ?? defaultChannelPost;
  }

  get registry(): ChannelRegistry {
    return this.#registry;
  }

  async send(threadId: string, envelope: Envelope): Promise<SendResult | undefined> {
    const local = this.#registry.get(threadId);
    if (local) {
      await local(envelope);
      return { transport: 'channel', delivered: true };
    }
    const remote = lookupListener(this.#statePath, threadId);
    if (!remote) return undefined;
    await this.#post(`${remote.url.replace(/\/+$/u, '')}/send`, envelope);
    return { transport: 'channel', delivered: true };
  }
}

export function channelPayload(envelope: Envelope): { content: string; meta: Record<string, string> } {
  return { content: formatChannelContent(envelope), meta: channelMeta(envelope) };
}
