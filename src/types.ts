import { z } from 'zod';

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

export const MESSAGE_TYPES = ['message', 'request', 'reply', 'ack'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** What a client may send. `from`, `id`, `seq` and `ts` are the server's to assign. */
export const sendMessage = z
  .object({
    to: z
      .string()
      .max(64)
      .refine((v) => v === '*' || AGENT_ID.test(v), 'must be an agent id or "*" for broadcast'),
    thread: z.string().regex(THREAD_ID, 'thread must be a plain slug'),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(256_000),
    type: z.enum(MESSAGE_TYPES).default('message'),
    refs: z.array(z.string().max(512)).max(32).optional(),
    in_reply_to: z.string().max(128).optional(),
  })
  .strict();

export type SendMessage = z.infer<typeof sendMessage>;

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
  type: MessageType;
  subject: string;
  body: string;
  refs?: string[];
  in_reply_to?: string;
  ts: string;
}

export interface Agent {
  id: string;
  /** Free text for humans and for `list_agents` — "the Grok bots on Thanos-OF". */
  description?: string;
  /** sha256 of the token. The token itself is never stored. */
  tokenHash: string;
  /** When false, the agent may read its inbox but not send. */
  canSend?: boolean;
  disabled?: boolean;
}

/** An agent as anyone is allowed to see it — no hash, no token. */
export interface PublicAgent {
  id: string;
  description?: string;
}

export function publicAgent(agent: Agent): PublicAgent {
  return {
    id: agent.id,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
  };
}
