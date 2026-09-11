import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Message, SendMessage } from './types.js';

/**
 * The mailbox itself: an append-only log plus the readers waiting on it.
 *
 * Append-only because the hard part of a message bus is not storage, it is
 * agreeing on what has already been seen. A monotonic `seq` and a per-reader
 * cursor make that a comparison instead of a protocol — a reader that crashes
 * and restarts asks for everything after the last seq it wrote down, and gets
 * exactly the messages it missed, once.
 *
 * The file is JSONL so a human can `tail -f` it. That has been worth more than
 * any query capability a database would have added.
 */

export interface StoreOptions {
  dir: string;
  /** Messages kept in memory for reads. The log on disk keeps everything. */
  window?: number;
}

const DEFAULT_WINDOW = 5_000;

interface Waiter {
  agent: string;
  cursor: number;
  thread?: string;
  resolve: (messages: Message[]) => void;
  timer: NodeJS.Timeout;
}

export class MailStore {
  readonly #dir: string;
  readonly #file: string;
  readonly #window: number;
  #messages: Message[] = [];
  #seq = 0;
  #waiters = new Set<Waiter>();

  constructor(options: StoreOptions) {
    this.#dir = options.dir;
    this.#window = options.window ?? DEFAULT_WINDOW;
    this.#file = join(this.#dir, 'messages.jsonl');
    mkdirSync(this.#dir, { recursive: true });
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#file)) return;
    const lines = readFileSync(this.#file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as Message;
        this.#messages.push(message);
        if (message.seq > this.#seq) this.#seq = message.seq;
      } catch {
        // A half-written final line is what a crash mid-append looks like.
        // Skipping it is right; refusing to boot over it is not.
      }
    }
    this.#trim();
  }

  #trim(): void {
    if (this.#messages.length > this.#window) {
      this.#messages = this.#messages.slice(-this.#window);
    }
  }

  /** The newest seq the mailbox has issued. A fresh reader starts here to skip history. */
  get head(): number {
    return this.#seq;
  }

  send(from: string, input: SendMessage): Message {
    const ts = new Date().toISOString();
    const stamp = ts.replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
    const message: Message = {
      id: `${stamp}-${from}-${randomBytes(4).toString('hex')}`,
      seq: ++this.#seq,
      thread: input.thread,
      from,
      to: input.to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      ...(input.refs !== undefined ? { refs: input.refs } : {}),
      ...(input.in_reply_to !== undefined ? { in_reply_to: input.in_reply_to } : {}),
      ts,
    };

    // Durable before observable: a message a reader has been handed must still
    // be there after a restart, so the append happens before the wake-up.
    appendFileSync(this.#file, `${JSON.stringify(message)}\n`, 'utf8');
    this.#messages.push(message);
    this.#trim();
    this.#wake(message);
    return message;
  }

  /** Is this message addressed to `agent`? Broadcasts reach everyone but their sender. */
  #addressed(message: Message, agent: string): boolean {
    if (message.to === agent) return true;
    return message.to === '*' && message.from !== agent;
  }

  /** Everything addressed to `agent` after `cursor`, oldest first. */
  since(agent: string, cursor: number, thread?: string): Message[] {
    return this.#messages.filter(
      (m) =>
        m.seq > cursor && this.#addressed(m, agent) && (thread === undefined || m.thread === thread)
    );
  }

  /** A whole thread, both directions — what an agent reads to recover context. */
  thread(agent: string, thread: string): Message[] {
    return this.#messages.filter(
      (m) => m.thread === thread && (this.#addressed(m, agent) || m.from === agent)
    );
  }

  /** Distinct threads this agent can see, newest activity first. */
  threads(agent: string): { thread: string; last_seq: number; last_ts: string; count: number }[] {
    const seen = new Map<string, { thread: string; last_seq: number; last_ts: string; count: number }>();
    for (const m of this.#messages) {
      if (!this.#addressed(m, agent) && m.from !== agent) continue;
      const prior = seen.get(m.thread);
      if (prior) {
        prior.count += 1;
        if (m.seq > prior.last_seq) {
          prior.last_seq = m.seq;
          prior.last_ts = m.ts;
        }
      } else {
        seen.set(m.thread, { thread: m.thread, last_seq: m.seq, last_ts: m.ts, count: 1 });
      }
    }
    return [...seen.values()].sort((a, b) => b.last_seq - a.last_seq);
  }

  /**
   * Long poll. Resolves the moment something addressed to `agent` arrives, or
   * with `[]` at `timeoutMs`.
   *
   * This is the whole reason the hub exists rather than a shared folder: the
   * gap between "an agent said something" and "the other agent knows" is a
   * network hop, not a poll interval. A 30 s poll loop averages 15 s of silence
   * per exchange, which is what makes agent-to-agent chat feel like email
   * instead of conversation.
   */
  wait(agent: string, cursor: number, timeoutMs: number, thread?: string): Promise<Message[]> {
    const ready = this.since(agent, cursor, thread);
    if (ready.length > 0) return Promise.resolve(ready);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        agent,
        cursor,
        ...(thread !== undefined ? { thread } : {}),
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          resolve([]);
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #wake(message: Message): void {
    for (const waiter of [...this.#waiters]) {
      if (!this.#addressed(message, waiter.agent)) continue;
      if (waiter.thread !== undefined && waiter.thread !== message.thread) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(this.since(waiter.agent, waiter.cursor, waiter.thread));
    }
  }

  /** Release every pending long poll. Call before exiting so the process can end. */
  close(): void {
    for (const waiter of [...this.#waiters]) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.#waiters.clear();
  }
}
