import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Cross-vendor adapter protocol. The hub owns routing; adapters own delivery.
 *
 * Address: `{vendor}:{thread_id}` (split on the first colon so thread ids may
 * contain colons). Envelope fields are the ones every vendor adapter must
 * speak — replies always go to `reply_to`, not back to `from` by coincidence.
 */

export const VENDORS = ['cursor', 'grok'] as const;
export type Vendor = (typeof VENDORS)[number];

export function isVendor(value: string): value is Vendor {
  return (VENDORS as readonly string[]).includes(value);
}

export interface Address {
  vendor: string;
  threadId: string;
}

export function parseAddress(raw: string): Address {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(':');
  if (sep <= 0 || sep === trimmed.length - 1) {
    throw new Error(
      `address must be "{vendor}:{thread_id}" (got ${JSON.stringify(raw)})`
    );
  }
  return { vendor: trimmed.slice(0, sep).toLowerCase(), threadId: trimmed.slice(sep + 1) };
}

export function formatAddress(vendor: string, threadId: string): string {
  if (!vendor || !threadId) throw new Error('vendor and thread_id are required');
  return `${vendor}:${threadId}`;
}

export const envelopeSchema = z
  .object({
    id: z.string().min(1).max(160),
    from: z.string().min(1).max(320),
    to: z.string().min(1).max(320),
    reply_to: z.string().min(1).max(320),
    correlation_id: z.string().min(1).max(160),
    body: z.string().min(1).max(256_000),
    created_at: z.string().min(1).max(64),
  })
  .strict();

export type Envelope = z.infer<typeof envelopeSchema>;

export interface SendResult {
  envelope: Envelope;
  transport: string;
  nativeId?: string;
}

export interface ReceiveCursor {
  token: string;
}

export interface ReceiveResult {
  envelopes: Envelope[];
  cursor: string;
}

export interface VendorAdapter {
  readonly vendor: Vendor;
  send(threadId: string, envelope: Envelope): Promise<SendResult>;
  receive(threadId: string, cursor?: string | undefined, waitMs?: number): Promise<ReceiveResult>;
}

export function mintId(from = 'adapter'): string {
  const ts = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  return `${ts}-${from.replace(/[^a-z0-9]+/giu, '-').slice(0, 24)}-${randomBytes(4).toString('hex')}`;
}

export function createEnvelope(input: {
  from: string;
  to: string;
  body: string;
  reply_to?: string;
  correlation_id?: string;
  id?: string;
  created_at?: string;
}): Envelope {
  parseAddress(input.from);
  parseAddress(input.to);
  const replyTo = input.reply_to ?? input.from;
  parseAddress(replyTo);
  return envelopeSchema.parse({
    id: input.id ?? mintId(parseAddress(input.from).vendor),
    from: input.from,
    to: input.to,
    reply_to: replyTo,
    correlation_id: input.correlation_id ?? randomBytes(8).toString('hex'),
    body: input.body,
    created_at: input.created_at ?? new Date().toISOString(),
  });
}

/** A reply that must land on the original `reply_to` thread. */
export function replyEnvelope(original: Envelope, body: string, from: string): Envelope {
  return createEnvelope({
    from,
    to: original.reply_to,
    reply_to: original.from,
    correlation_id: original.correlation_id,
    body,
  });
}
