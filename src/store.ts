import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Chat, Message, SendMessage } from './types.js';
import { slugify } from './types.js';
import { parseAddress } from './protocol.js';

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
  mailboxes: string[];
  cursor: number;
  thread?: string;
  resolve: (messages: Message[]) => void;
  timer: NodeJS.Timeout;
}

export class MailStore {
  readonly #dir: string;
  readonly #file: string;
  readonly #chatsFile: string;
  readonly #window: number;
  #messages: Message[] = [];
  #seq = 0;
  #waiters = new Set<Waiter>();
  #chats = new Map<string, Chat>();
  #chatsDirty = false;

  constructor(options: StoreOptions) {
    this.#dir = options.dir;
    this.#window = options.window ?? DEFAULT_WINDOW;
    this.#file = join(this.#dir, 'messages.jsonl');
    this.#chatsFile = join(this.#dir, 'chats.json');
    mkdirSync(this.#dir, { recursive: true });
    this.#load();
    this.#loadChats();
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
      thread: input.thread ?? 'n2n',
      from,
      to: input.to,
      type: input.type,
      subject: input.subject ?? 'message',
      body: input.body,
      ...(input.refs !== undefined ? { refs: input.refs } : {}),
      ...(input.in_reply_to !== undefined ? { in_reply_to: input.in_reply_to } : {}),
      ...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}),
      ...(input.correlation_id !== undefined ? { correlation_id: input.correlation_id } : {}),
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

  get(id: string): Message | undefined {
    for (let i = this.#messages.length - 1; i >= 0; i -= 1) {
      const message = this.#messages[i];
      if (message?.id === id) return message;
    }
    return undefined;
  }

  #names(mailbox: string | string[]): string[] {
    return Array.isArray(mailbox) ? mailbox : [mailbox];
  }

  /**
   * Is this message addressed to `mailbox`?
   *
   * Broadcasts reach everyone but their sender. A vendor name (`codex`)
   * matches every `codex:<thread>` address so an adapter can poll one inbox
   * for its whole vendor.
   */
  #addressed(message: Message, mailboxes: string[]): boolean {
    const set = new Set(mailboxes);
    if (set.has(message.to)) return true;
    if (message.to === '*') {
      if (set.has(message.from)) return false;
      const src = parseAddress(message.from);
      if (src !== undefined && set.has(src.vendor)) return false;
      return true;
    }
    const dest = parseAddress(message.to);
    return dest !== undefined && set.has(dest.vendor);
  }

  /** Sender or recipient of this message — used to recover a whole thread. */
  #involved(message: Message, mailboxes: string[]): boolean {
    if (this.#addressed(message, mailboxes)) return true;
    const set = new Set(mailboxes);
    if (set.has(message.from)) return true;
    const src = parseAddress(message.from);
    return src !== undefined && set.has(src.vendor);
  }

  /** Everything addressed to `mailbox` after `cursor`, oldest first. */
  since(mailbox: string | string[], cursor: number, thread?: string): Message[] {
    const mailboxes = this.#names(mailbox);
    return this.#messages.filter(
      (m) =>
        m.seq > cursor && this.#addressed(m, mailboxes) && (thread === undefined || m.thread === thread)
    );
  }

  /** A whole thread, both directions — what an agent reads to recover context. */
  thread(mailbox: string | string[], thread: string): Message[] {
    const mailboxes = this.#names(mailbox);
    return this.#messages.filter((m) => m.thread === thread && this.#involved(m, mailboxes));
  }

  /** Distinct threads this agent can see, newest activity first. */
  threads(mailbox: string | string[]): { thread: string; last_seq: number; last_ts: string; count: number }[] {
    const mailboxes = this.#names(mailbox);
    const seen = new Map<string, { thread: string; last_seq: number; last_ts: string; count: number }>();
    for (const m of this.#messages) {
      if (!this.#involved(m, mailboxes)) continue;
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
  wait(mailbox: string | string[], cursor: number, timeoutMs: number, thread?: string): Promise<Message[]> {
    const mailboxes = this.#names(mailbox);
    const ready = this.since(mailboxes, cursor, thread);
    if (ready.length > 0) return Promise.resolve(ready);

    return new Promise((resolve) => {
      const waiter: Waiter = {
        mailboxes,
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
      if (!this.#addressed(message, waiter.mailboxes)) continue;
      if (waiter.thread !== undefined && waiter.thread !== message.thread) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(this.since(waiter.mailboxes, waiter.cursor, waiter.thread));
    }
  }

  // ---------------------------------------------------------------- chats

  /**
   * Claim a chat name as an address.
   *
   * Re-registering is the normal case, not an error: a session restarts, or
   * reconnects after the hub bounced, and announces the same name again. What
   * is refused is a *different* agent claiming a name already taken, because
   * the whole guarantee is that mail addressed to a chat reaches that chat.
   */
  registerChat(owner: string, name: string): Chat {
    const slug = slugify(name);
    if (!slug) throw new Error(`"${name}" has no addressable characters in it`);

    const now = new Date().toISOString();
    const existing = this.#chats.get(slug);
    if (existing) {
      if (existing.owner !== owner) {
        throw new Error(`chat "${slug}" is already registered by "${existing.owner}"`);
      }
      // Keep `created`, refresh the display name — a chat can be renamed as
      // long as it still slugifies the same.
      existing.name = name;
      existing.lastSeen = now;
      this.#saveChats();
      return existing;
    }

    const chat: Chat = { slug, name, owner, created: now, lastSeen: now };
    this.#chats.set(slug, chat);
    this.#saveChats();
    return chat;
  }

  /** Resolve an agent id, a chat slug, or a chat's display name pasted verbatim. */
  resolveChat(to: string): Chat | undefined {
    return this.#chats.get(to) ?? this.#chats.get(slugify(to));
  }

  chats(): Chat[] {
    return [...this.#chats.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  /** Mark a chat as still listening. Called on every poll by its listener. */
  touchChat(slug: string): void {
    const chat = this.#chats.get(slug);
    if (!chat) return;
    chat.lastSeen = new Date().toISOString();
    // Not persisted on every poll — a listener touches this every few seconds
    // and the only thing lost on a crash is a slightly stale `lastSeen`.
    this.#chatsDirty = true;
  }

  /** Flush presence updates. The server calls this on a timer. */
  flushChats(): void {
    if (!this.#chatsDirty) return;
    this.#saveChats();
  }

  #loadChats(): void {
    if (!existsSync(this.#chatsFile)) return;
    try {
      const chats = JSON.parse(readFileSync(this.#chatsFile, 'utf8')) as Chat[];
      for (const chat of chats) this.#chats.set(chat.slug, chat);
    } catch {
      // A corrupt registry loses addresses, not messages. Listeners re-register
      // on their next start, so booting empty beats refusing to boot.
    }
  }

  #saveChats(): void {
    writeFileSync(this.#chatsFile, `${JSON.stringify([...this.#chats.values()], null, 2)}\n`, 'utf8');
    this.#chatsDirty = false;
  }

  /** Release every pending long poll. Call before exiting so the process can end. */
  close(): void {
    this.flushChats();
    for (const waiter of [...this.#waiters]) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.#waiters.clear();
  }
}
