import { z } from 'zod';
import { formatAddress, VENDOR_ID } from './protocol.js';

/**
 * The wire protocol.
 *
 * Deliberately small: an agent that can make an HTTP request can join, with no
 * SDK and no MCP client. Everything an agent needs to know about another agent
 * is its `id` — addresses are flat, not URLs, so a mailbox can move hosts
 * without every peer being reconfigured.
 */

/** `a-z0-9-_`, 1-64 chars. The same shape as the token prefix, so ids are greppable in logs. */
export const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

/** A thread is a conversation. Reusing one is how context survives across messages. */
export const THREAD_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

/**
 * Chats are addresses too, and they are the point of the whole package.
 *
 * A human copies a chat's name out of their client — "Project status check
 * (fork)" — pastes it into some other agent's instructions, and that agent can
 * write to it. So the address has to survive a round trip through a sentence:
 * mixed case, spaces, parentheses. `slugify` is what makes the pasted name and
 * the stored one the same address, and it has to be applied on both sides or
 * senders will be told a chat they can plainly see does not exist.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96);
}

export interface Chat {
  /** The address. Derived from `name`, stable, safe in a URL. */
  slug: string;
  /** As the human typed it, for display and for matching a pasted name. */
  name: string;
  /** Agent id that registered it. Only that agent may re-register or read it. */
  owner: string;
  created: string;
  /**
   * Last time a listener polled. A sender reads this to know whether anyone is
   * home; mail to a quiet chat still queues, because this is a mailbox.
   */
  lastSeen: string;
}

export const registerChat = z
  .object({
    name: z.string().min(1).max(160),
  })
  .strict();

export const MESSAGE_TYPES = ['message', 'request', 'reply', 'ack'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Wire form of a vendor thread address. */
const addressObject = z
  .object({
    vendor: z.string().regex(VENDOR_ID),
    thread_id: z.string().min(1).max(256).refine((s) => !/\s/u.test(s), 'thread_id must not contain whitespace'),
  })
  .strict();

/** `vendor:thread_id`, a pasted chat name, an agent id, or `{vendor, thread_id}`. */
const addressWire = z.union([z.string().min(1).max(320), addressObject]);

function wireToString(value: string | { vendor: string; thread_id: string }): string {
  return typeof value === 'string' ? value : formatAddress(value);
}

/** What a client may send. `id`, `seq` and `ts` are the server's to assign. */
export const sendMessage = z
  .object({
    // Deliberately permissive: an agent id, a chat slug, a chat's display name
    // pasted verbatim out of a client, a `vendor:thread_id` address, or "*".
    // The hub resolves it and says so if it cannot — rejecting "Project status
    // check (fork)" here for having spaces in it would be rejecting the
    // package's original use case.
    to: addressWire,
    thread: z.string().regex(THREAD_ID, 'thread must be a plain slug').optional(),
    subject: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(256_000),
    type: z.enum(MESSAGE_TYPES).default('message'),
    refs: z.array(z.string().max(512)).max(32).optional(),
    in_reply_to: z.string().max(128).optional(),
    reply_to: addressWire.optional(),
    correlation_id: z.string().min(1).max(128).optional(),
    /**
     * Originating native thread. Combined with the authenticated agent's
     * vendor into `from` (`grok:abc`). Prefer this over sending `from`.
     */
    from_thread: z.string().min(1).max(256).optional(),
    /**
     * Originating address. Allowed only as `vendor:thread_id` whose vendor
     * matches the token — it is not a way to send as someone else.
     */
    from: addressWire.optional(),
  })
  .strict()
  .transform((data) => ({
    to: wireToString(data.to),
    body: data.body,
    type: data.type,
    ...(data.thread !== undefined ? { thread: data.thread } : {}),
    ...(data.subject !== undefined ? { subject: data.subject } : {}),
    ...(data.refs !== undefined ? { refs: data.refs } : {}),
    ...(data.in_reply_to !== undefined ? { in_reply_to: data.in_reply_to } : {}),
    ...(data.reply_to !== undefined ? { reply_to: wireToString(data.reply_to) } : {}),
    ...(data.correlation_id !== undefined ? { correlation_id: data.correlation_id } : {}),
    ...(data.from_thread !== undefined ? { from_thread: data.from_thread } : {}),
    ...(data.from !== undefined ? { from: wireToString(data.from) } : {}),
  }));

export type SendMessage = z.output<typeof sendMessage>;

export interface Message {
  /** `<utc>-<from>-<rand>`; unique, sortable, and says who wrote it without a lookup. */
  id: string;
  /**
   * Monotonic per-mailbox. This is the cursor: a reader remembers the last seq
   * it saw and asks for everything after it. Ordering by timestamp would drop
   * messages that share a millisecond.
   */
  seq: number;
  thread: string;
  from: string;
  to: string;
  /**
   * The name the sender actually asked for, when it did not resolve to a
   * registered address and was handed to a relay instead.
   *
   * Kept verbatim rather than normalised: the relay has to match it against
   * live session titles, and that match is better made against what a human
   * typed than against something this service guessed at.
   */
  to_name?: string;
  type: MessageType;
  subject: string;
  body: string;
  refs?: string[];
  in_reply_to?: string;
  /**
   * Where a reply must go: a `vendor:thread_id`, agent id, or chat slug.
   * The hub sets this to `from` for n-to-n mail so the other side can
   * answer the originating thread without being told twice.
   */
  reply_to?: string;
  correlation_id?: string;
  ts: string;
}

export interface Agent {
  id: string;
  /** Free text for humans and for `list_agents` — "the Grok bots on Thanos-OF". */
  description?: string;
  /**
   * Vendor this agent posts as (`grok`, `codex`, …). Inferred from `id` when
   * omitted (`grokbot` → `grok`). Required to mint `vendor:thread_id` from
   * addresses; chat-by-name senders do not need it.
   */
  vendor?: string;
  /** sha256 of the token. The token itself is never stored. */
  tokenHash: string;
  /** When false, the agent may read its inbox but not send. */
  canSend?: boolean;
  /**
   * Catches mail whose recipient resolves to nothing.
   *
   * Without a relay, addressing a chat that has no listener is a 404 and the
   * sender can do nothing about it. With one, the message is accepted and the
   * relay decides where it belongs — which is the only way to reach a chat that
   * has never announced itself, and that is most of them.
   */
  relay?: boolean;
  disabled?: boolean;
}

/** An agent as anyone is allowed to see it — no hash, no token. */
export interface PublicAgent {
  id: string;
  description?: string;
  vendor?: string;
}

export function publicAgent(agent: Agent): PublicAgent {
  return {
    id: agent.id,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.vendor !== undefined ? { vendor: agent.vendor } : {}),
  };
}

/** Inbox keys for this agent: its id, plus its vendor so `grok:*` reaches grokbot. */
export function inboxNames(agent: Agent): string[] {
  if (agent.vendor !== undefined && agent.vendor !== agent.id) return [agent.id, agent.vendor];
  return [agent.id];
}
