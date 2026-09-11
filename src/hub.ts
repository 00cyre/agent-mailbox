import type { AdapterRegistry } from './adapter.js';
import type { AgentRegistry } from './config.js';
import type { MailStore } from './store.js';
import { inboxNames, type Agent, type Message, type SendMessage } from './types.js';
import {
  formatAddress,
  formatReplyDestination,
  isAddress,
  parseAddress,
  toEnvelope,
  type Address,
  type Envelope,
} from './protocol.js';

/**
 * One send path for HTTP, MCP, and the CLI.
 *
 * Resolution, reply routing, persistence, and adapter dispatch happen here so
 * the original mailbox (agents, chats, long-poll inbox) and the n-to-n
 * envelope are the same system. A message addressed to `codex:xyz` is stored
 * like any other, then handed to the Codex adapter as `send("xyz", envelope)`.
 */

export class HubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
  }
}

export interface HubOptions {
  store: MailStore;
  agents: AgentRegistry;
  adapters: AdapterRegistry;
}

export class MailboxHub {
  readonly store: MailStore;
  readonly agents: AgentRegistry;
  readonly adapters: AdapterRegistry;

  constructor(options: HubOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.adapters = options.adapters;
  }

  /**
   * Post a message. `from` on the wire is a `vendor:thread_id` bound to the
   * authenticated agent's vendor — never an arbitrary identity. Replies with
   * `in_reply_to` ignore the caller's `to` and go to the original's
   * `reply_to`, or its `from` if none was set.
   */
  async send(agent: Agent, input: SendMessage): Promise<Message> {
    if (agent.canSend === false) {
      throw new HubError(403, `agent "${agent.id}" is read-only`);
    }

    const from = this.#resolveFrom(agent, input);
    let resolved = this.#resolveTo(input.to);
    let replyTo = input.reply_to !== undefined ? this.#resolveReplyTo(input.reply_to) : undefined;
    let correlationId = input.correlation_id;

    if (input.in_reply_to !== undefined) {
      const original = this.store.get(input.in_reply_to);
      if (!original) {
        throw new HubError(404, `no message "${input.in_reply_to}" to reply to`);
      }
      resolved = { to: formatReplyDestination(original) };
      correlationId = correlationId ?? original.correlation_id ?? original.id;
      if (replyTo === undefined && isAddress(from)) replyTo = from;
    } else if (replyTo === undefined && isAddress(from)) {
      // Default the return path to the originating thread so the other side
      // does not have to guess which of the sender's chats to answer.
      replyTo = from;
    }

    const message = this.store.send(from, {
      to: resolved.to,
      thread: input.thread ?? 'n2n',
      subject: input.subject ?? 'message',
      body: input.body,
      type: input.type,
      ...(input.refs !== undefined ? { refs: input.refs } : {}),
      ...(input.in_reply_to !== undefined ? { in_reply_to: input.in_reply_to } : {}),
      ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
      ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
      ...(resolved.to_name !== undefined ? { to_name: resolved.to_name } : {}),
    });

    const dest = parseAddress(message.to);
    const envelope = dest !== undefined ? this.#envelopeFor(agent, message, dest) : undefined;
    if (dest !== undefined && envelope !== undefined) {
      await this.adapters.deliver(dest.thread_id, envelope);
    }

    return message;
  }

  /**
   * Listen for mail to a vendor (or agent id). Same cursor-ack as
   * `GET /v1/inbox`: pass back the last seq you saw.
   */
  listen(mailbox: string | string[], cursor: number, waitMs: number, thread?: string) {
    return this.store.wait(mailbox, cursor, waitMs, thread);
  }

  listenAs(agent: Agent, cursor: number, waitMs: number, thread?: string) {
    return this.listen(inboxNames(agent), cursor, waitMs, thread);
  }

  #resolveFrom(agent: Agent, input: SendMessage): string {
    const vendor = agent.vendor;
    if (input.from !== undefined) {
      const address = parseAddress(input.from);
      if (!address) {
        throw new HubError(400, `from must be a vendor:thread_id address (got ${JSON.stringify(input.from)})`);
      }
      if (vendor === undefined) {
        throw new HubError(400, `agent "${agent.id}" has no vendor; cannot set from`);
      }
      if (address.vendor !== vendor) {
        throw new HubError(
          400,
          `from vendor "${address.vendor}" does not match authenticated vendor "${vendor}"`
        );
      }
      return formatAddress(address);
    }
    if (input.from_thread !== undefined) {
      if (vendor === undefined) {
        throw new HubError(400, `agent "${agent.id}" has no vendor; cannot bind from_thread`);
      }
      return formatAddress({ vendor, thread_id: input.from_thread });
    }
    return agent.id;
  }

  /**
   * Broadcast, a vendor thread, a registered agent, then a chat by slug or
   * pasted display name — the original resolution order, with addresses first
   * so `codex:abc` never collides with a chat named that.
   */
  #resolveTo(raw: string): { to: string; to_name?: string } {
    if (raw === '*') return { to: '*' };
    const address = parseAddress(raw);
    if (address) return { to: formatAddress(address) };
    if (this.agents.has(raw)) return { to: raw };
    const chat = this.store.resolveChat(raw);
    if (chat) return { to: chat.slug };
    const relay = this.agents.relay();
    if (relay) return { to: relay.id, to_name: raw };
    throw new HubError(
      404,
      `no agent or chat "${raw}" on this mailbox — GET /v1/chats lists the chats that are listening`
    );
  }

  #resolveReplyTo(raw: string): string {
    const address = parseAddress(raw);
    if (address) return formatAddress(address);
    if (this.agents.has(raw)) return raw;
    const chat = this.store.resolveChat(raw);
    if (chat) return chat.slug;
    throw new HubError(400, `reply_to is not an address, agent, or chat: ${JSON.stringify(raw)}`);
  }

  #envelopeFor(agent: Agent, message: Message, dest: Address): Envelope | undefined {
    const parsed = toEnvelope(message);
    if (parsed) return parsed;
    // Old-style `from` is an agent id. Synthesize an address so the adapter
    // still sees a well-formed envelope when the destination is a vendor thread.
    const vendor = agent.vendor;
    if (vendor === undefined) return undefined;
    const from = parseAddress(message.from) ?? { vendor, thread_id: message.from };
    const reply_to =
      message.reply_to !== undefined
        ? (parseAddress(message.reply_to) ?? { vendor, thread_id: message.reply_to })
        : undefined;
    return {
      id: message.id,
      from,
      to: dest,
      ...(reply_to !== undefined ? { reply_to } : {}),
      ...(message.correlation_id !== undefined ? { correlation_id: message.correlation_id } : {}),
      body: message.body,
      created_at: message.ts,
    };
  }
}
