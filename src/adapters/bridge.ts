import { createEnvelope, formatAddress, parseAddress, type Envelope } from './protocol.js';
import { replyToFromRefs, refsWithReplyTo } from './format.js';
import type { AdapterHub } from './hub.js';
import type { Message } from '../types.js';

export interface MailboxClient {
  send(input: {
    to: string;
    thread: string;
    subject: string;
    body: string;
    in_reply_to?: string;
    refs?: string[];
  }): Promise<unknown>;
  inbox(cursor: number, waitMs: number): Promise<{ data: Message[]; cursor: number }>;
  whoami(): Promise<{ agent: { id: string }; head: number }>;
}

/**
 * Map a hub message onto the adapter envelope without changing the hub schema.
 *
 * `to` may already be `cursor:bc-…`. Otherwise the mailbox agent id is the
 * vendor (`cursor` / `grok`) and `thread` is the vendor thread id.
 */
export function envelopeFromMailbox(message: Message, vendorFallback: string): Envelope {
  let to = message.to;
  try {
    parseAddress(to);
  } catch {
    to = formatAddress(vendorFallback, message.thread);
  }
  const replyTo = replyToFromRefs(message.refs) ?? formatAddress(message.from, message.thread);
  let from = message.from;
  try {
    parseAddress(from);
  } catch {
    from = formatAddress(message.from, message.thread);
  }
  return createEnvelope({
    id: message.id,
    from,
    to,
    reply_to: replyTo,
    correlation_id: message.in_reply_to ?? message.id,
    body: message.body,
    created_at: message.ts,
  });
}

export function mailboxTarget(address: string): { to: string; thread: string } {
  const parsed = parseAddress(address);
  return { to: parsed.vendor, thread: parsed.threadId };
}

export async function createMailboxClient(url: string, token: string): Promise<MailboxClient> {
  const base = url.replace(/\/+$/u, '');

  async function api(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload['error'] as { message?: string } | undefined;
      throw new Error(`${response.status}: ${error?.message ?? JSON.stringify(payload)}`);
    }
    return payload;
  }

  return {
    async send(input) {
      return api('/v1/send', { method: 'POST', body: JSON.stringify(input) });
    },
    async inbox(cursor, waitMs) {
      const params = new URLSearchParams({ cursor: String(cursor), wait: String(waitMs) });
      return api(`/v1/inbox?${params}`) as Promise<{ data: Message[]; cursor: number }>;
    },
    async whoami() {
      return api('/v1/whoami') as Promise<{ agent: { id: string }; head: number }>;
    },
  };
}

/**
 * Long-poll the mailbox as `cursor` or `grok`, inject into the vendor thread,
 * then post the vendor's reply back to `reply_to`.
 */
export async function runMailboxBridge(
  hub: AdapterHub,
  client: MailboxClient,
  options: { waitReplyMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const waitReplyMs = options.waitReplyMs ?? 180_000;
  const who = await client.whoami();
  let cursor = who.head;
  const vendor = who.agent.id;

  while (!options.signal?.aborted) {
    const batch = await client.inbox(cursor, 25_000);
    cursor = batch.cursor;
    for (const message of batch.data) {
      const envelope = envelopeFromMailbox(message, vendor);
      const sent = await hub.send(envelope);
      const dest = parseAddress(envelope.to);
      const received = await hub.receive(
        formatAddress(dest.vendor, dest.threadId),
        sent.nativeId,
        waitReplyMs
      );
      for (const reply of received.envelopes) {
        const local = await hub.deliverIfLocal(reply);
        if (local) continue;
        const target = mailboxTarget(reply.to);
        await client.send({
          to: target.to,
          thread: target.thread,
          subject: `reply ${envelope.correlation_id}`,
          body: reply.body,
          in_reply_to: envelope.id,
          refs: refsWithReplyTo(reply.reply_to),
        });
      }
    }
  }
}
