import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { VendorAdapter } from '../adapter.js';
import {
  formatAddress,
  parseAddress,
  replyDestination,
  type Address,
  type Envelope,
  type Vendor,
} from '../protocol.js';

/**
 * Adapter helpers on top of the hub protocol in `src/protocol.ts`.
 * Do not add a second envelope here — Address / Envelope / parseAddress live on the hub.
 */
export {
  KNOWN_VENDORS,
  VENDOR_ALIASES,
  VENDOR_ID,
  formatAddress,
  formatReplyDestination,
  inferVendor,
  isAddress,
  parseAddress,
  replyDestination,
  toEnvelope,
  type Address,
  type Envelope,
  type KnownVendor,
  type Vendor,
} from '../protocol.js';
export type { VendorAdapter } from '../adapter.js';

export const addressObject = z.object({
  vendor: z.string().min(1),
  thread_id: z.string().min(1),
});

export function coerceAddress(raw: Address | string): Address | undefined {
  if (typeof raw === 'string') return parseAddress(raw);
  if (raw.vendor && raw.thread_id) return { vendor: raw.vendor, thread_id: raw.thread_id };
  return undefined;
}

export function addressText(raw: Address | string): string {
  return typeof raw === 'string' ? raw : formatAddress(raw);
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

/** Claude transport report — not the hub `VendorAdapter.send` return (that is void). */
export interface SendResult {
  transport: ClaudeTransport;
  delivered: boolean;
  replyBody?: string;
}

export interface AdapterSendResult {
  envelope: Envelope;
  transport: string;
  nativeId?: string;
}

export interface ReceiveResult {
  envelopes: Envelope[];
  cursor: string;
}

export function newEnvelopeId(vendor: string): string {
  const ts = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  return `${ts}-${vendor}-${randomBytes(4).toString('hex')}`;
}

export function createEnvelope(input: {
  from: string | Address;
  to: string | Address;
  body: string;
  reply_to?: string | Address;
  correlation_id?: string;
  id?: string;
  created_at?: string;
}): Envelope {
  const from = coerceAddress(input.from);
  const to = coerceAddress(input.to);
  if (!from || !to) {
    throw new Error('from/to must be vendor:thread_id');
  }
  const reply_to =
    input.reply_to !== undefined ? coerceAddress(input.reply_to) : from;
  if (input.reply_to !== undefined && !reply_to) {
    throw new Error('reply_to must be vendor:thread_id');
  }
  return {
    id: input.id ?? newEnvelopeId(from.vendor),
    from,
    to,
    ...(reply_to !== undefined ? { reply_to } : {}),
    correlation_id: input.correlation_id ?? randomBytes(8).toString('hex'),
    body: input.body,
    created_at: input.created_at ?? new Date().toISOString(),
  };
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

/** Local Cursor/Grok loopback: an adapter that can also receive native replies. */
export interface ListeningVendorAdapter extends VendorAdapter {
  deliver?(threadId: string, envelope: Envelope): Promise<AdapterSendResult>;
  receive?(threadId: string, cursor?: string | undefined, waitMs?: number): Promise<ReceiveResult>;
}
