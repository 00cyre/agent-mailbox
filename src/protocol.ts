/**
 * The n-to-n envelope protocol.
 *
 * The existing mailbox still addresses agents and chats by name. This layer
 * sits on the same hub and names a *vendor-native thread* so any agent can
 * write into any other agent's conversation, and a reply can land back on the
 * thread that started it.
 *
 *   grok:abc  →  codex:xyz   (Grokbot on thread X talks to Codex on thread Y)
 *   reply to  grok:abc       (Codex answers on X, not on some other Grok chat)
 *
 * Sibling adapters match this file. Do not invent a second envelope.
 */

/** Built-in vendors. The parser accepts any `VENDOR_ID`, so this list is not closed. */
export const KNOWN_VENDORS = ['claude', 'cursor', 'grok', 'codex', 'chatgpt'] as const;
export type KnownVendor = (typeof KNOWN_VENDORS)[number];

/** Extensible: a new adapter registers under a new vendor string and the hub routes to it. */
export type Vendor = string;

/** `claude`, `grokbot`, `chat-gpt`. Same shape as an agent id, on purpose. */
export const VENDOR_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

/**
 * Agent ids that are not themselves vendor names. `init claude grokbot` should
 * still route Grokbot mail to the `grok` adapter.
 */
export const VENDOR_ALIASES: Record<string, KnownVendor> = {
  grokbot: 'grok',
  gpt: 'chatgpt',
  openai: 'codex',
};

/** `{vendor}:{thread_id}` — everything after the first colon is the native thread id. */
export interface Address {
  vendor: Vendor;
  thread_id: string;
}

/**
 * What an adapter `send`s into a native thread. `created_at` is assigned by
 * the hub (`Message.ts`); adapters do not mint ids.
 */
export interface Envelope {
  id: string;
  from: Address;
  to: Address;
  reply_to?: Address;
  correlation_id?: string;
  body: string;
  created_at: string;
}

export function formatAddress(address: Address): string {
  return `${address.vendor}:${address.thread_id}`;
}

/**
 * Parse `vendor:thread_id`. Returns undefined for agent ids, chat names, and
 * `*` — those stay on the original addressing path.
 */
export function parseAddress(raw: string): Address | undefined {
  const trimmed = raw.trim();
  const split = trimmed.indexOf(':');
  if (split <= 0) return undefined;
  const vendor = trimmed.slice(0, split).toLowerCase();
  const thread_id = trimmed.slice(split + 1);
  if (!VENDOR_ID.test(vendor)) return undefined;
  if (!thread_id || thread_id.length > 256 || /\s/u.test(thread_id)) return undefined;
  return { vendor, thread_id };
}

export function isAddress(raw: string): boolean {
  return parseAddress(raw) !== undefined;
}

/**
 * Where a reply to this envelope must go. `reply_to` wins so a sender can
 * pin the return path to the originating thread even if `from` is a
 * different listener; otherwise the return path is `from`.
 */
export function replyDestination(input: { reply_to?: Address | string; from: Address | string }): Address | string {
  return input.reply_to ?? input.from;
}

export function formatReplyDestination(input: { reply_to?: string; from: string }): string {
  const dest = replyDestination(input);
  return typeof dest === 'string' ? dest : formatAddress(dest);
}

export function inferVendor(agentId: string, explicit?: string): string | undefined {
  if (explicit !== undefined) {
    if (!VENDOR_ID.test(explicit)) {
      throw new Error(`invalid vendor ${JSON.stringify(explicit)}`);
    }
    return explicit;
  }
  if ((KNOWN_VENDORS as readonly string[]).includes(agentId)) return agentId;
  return VENDOR_ALIASES[agentId];
}

/** Map a stored message onto the envelope adapters consume. */
export function toEnvelope(message: {
  id: string;
  from: string;
  to: string;
  reply_to?: string;
  correlation_id?: string;
  body: string;
  ts: string;
}): Envelope | undefined {
  const from = parseAddress(message.from);
  const to = parseAddress(message.to);
  if (!from || !to) return undefined;
  const reply_to = message.reply_to !== undefined ? parseAddress(message.reply_to) : undefined;
  return {
    id: message.id,
    from,
    to,
    ...(reply_to !== undefined ? { reply_to } : {}),
    ...(message.correlation_id !== undefined ? { correlation_id: message.correlation_id } : {}),
    body: message.body,
    created_at: message.ts,
  };
}
