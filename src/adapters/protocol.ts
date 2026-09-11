import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * The n-to-n envelope protocol.
 *
 * Sibling of the hub's `src/protocol.ts` (PR that extends the mailbox). Same
 * fields, same `{vendor}:{thread_id}` addresses. Do not invent a second envelope.
 * When that file lands on main, this module should import it instead of
 * duplicating it.
 *
 *   grok:abc  →  claude:xyz
 *   reply to  grok:abc
 */

export const KNOWN_VENDORS = ['claude', 'cursor', 'grok', 'codex', 'chatgpt'] as const;
export type KnownVendor = (typeof KNOWN_VENDORS)[number];

export type Vendor = string;

export const VENDOR_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

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
 * What an adapter `send`s into a native thread.
 * On the wire, `from` / `to` / `reply_to` are the strings `vendor:thread_id`.
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

export const addressObject = z.object({
  vendor: z.string().min(1),
  thread_id: z.string().min(1),
});

export function formatAddress(address: Address): string {
  return `${address.vendor}:${address.thread_id}`;
}

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

export function coerceAddress(raw: Address | string): Address | undefined {
  if (typeof raw === 'string') return parseAddress(raw);
  if (raw.vendor && raw.thread_id) return { vendor: raw.vendor, thread_id: raw.thread_id };
  return undefined;
}

export function addressText(raw: Address | string): string {
  return typeof raw === 'string' ? raw : formatAddress(raw);
}

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

const wireAddress = z.union([z.string().min(1), addressObject]);

export const envelopeSchema = z
  .object({
    id: z.string().min(1).max(128),
    from: wireAddress,
    to: wireAddress,
    reply_to: wireAddress.optional(),
    correlation_id: z.string().min(1).max(128).optional(),
    body: z.string().min(1).max(256_000),
    created_at: z.string().min(1).max(64),
  })
  .strict()
  .transform((value, ctx): Envelope => {
    const from = coerceAddress(value.from);
    const to = coerceAddress(value.to);
    if (!from || !to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from/to must be vendor:thread_id' });
      return z.NEVER;
    }
    const reply_to = value.reply_to !== undefined ? coerceAddress(value.reply_to) : undefined;
    if (value.reply_to !== undefined && !reply_to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reply_to must be vendor:thread_id' });
      return z.NEVER;
    }
    return {
      id: value.id,
      from,
      to,
      ...(reply_to !== undefined ? { reply_to } : {}),
      ...(value.correlation_id !== undefined ? { correlation_id: value.correlation_id } : {}),
      body: value.body,
      created_at: value.created_at,
    };
  });

export type ClaudeTransport = 'channel' | 'code-cli' | 'desktop' | 'listen';

export interface SendResult {
  transport: ClaudeTransport;
  delivered: boolean;
  replyBody?: string;
}

/**
 * Hub contract. `send` is fire-into-thread; listen/ack is still GET /v1/inbox.
 * Return type is void so this class can `AdapterRegistry.register`.
 */
export interface VendorAdapter {
  readonly vendor: Vendor;
  send(threadId: string, envelope: Envelope): Promise<void>;
}

export function newEnvelopeId(vendor: string): string {
  const ts = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  return `${ts}-${vendor}-${randomBytes(4).toString('hex')}`;
}

export function buildReplyEnvelope(input: {
  threadId: string;
  vendor?: string;
  inbound: Envelope;
  body: string;
  id?: string;
  created_at?: string;
}): Envelope {
  const vendor = input.vendor ?? 'claude';
  const dest = replyDestination(input.inbound);
  const to = coerceAddress(dest);
  if (!to) {
    throw new Error(`cannot reply: destination ${addressText(dest)} is not vendor:thread_id`);
  }
  return {
    id: input.id ?? newEnvelopeId(vendor),
    from: { vendor, thread_id: input.threadId },
    to,
    reply_to: input.inbound.from,
    correlation_id: input.inbound.correlation_id ?? input.inbound.id,
    body: input.body,
    created_at: input.created_at ?? new Date().toISOString(),
  };
}
