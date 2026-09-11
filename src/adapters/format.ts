import { randomBytes } from 'node:crypto';
import {
  formatAddress,
  parseAddress,
  type Address,
  type Envelope,
} from '../protocol.js';

export const REF_REPLY_TO = 'mailbox:reply_to:';
export const REF_CORRELATION = 'mailbox:correlation:';
export const REF_FROM = 'mailbox:from:';
export const REF_ENVELOPE_ID = 'mailbox:id:';

export function addr(vendor: string, threadId: string): Address {
  return { vendor, thread_id: threadId };
}

export function addressText(value: Address | string): string {
  return typeof value === 'string' ? value : formatAddress(value);
}

/**
 * Text pasted into the native Codex / ChatGPT composer.
 *
 * Headers are routing metadata, not instructions to obey. The receiving
 * thread's reply is captured by the adapter and posted to `reply_to`.
 */
export function renderInbound(envelope: Envelope): string {
  const replyTo = envelope.reply_to ?? envelope.from;
  return (
    `[agent-mailbox]\n` +
    `from: ${formatAddress(envelope.from)}\n` +
    `to: ${formatAddress(envelope.to)}\n` +
    `reply_to: ${formatAddress(replyTo)}\n` +
    `correlation_id: ${envelope.correlation_id ?? envelope.id}\n` +
    `id: ${envelope.id}\n` +
    `\n` +
    envelope.body
  );
}

export function newEnvelopeId(at = new Date().toISOString()): string {
  const stamp = at.replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

/** Native reply that must land on the inbound `reply_to` (else `from`). */
export function replyEnvelope(inbound: Envelope, body: string, from: Address): Envelope {
  const to = inbound.reply_to ?? inbound.from;
  return {
    id: newEnvelopeId(),
    from,
    to,
    reply_to: inbound.to,
    ...(inbound.correlation_id !== undefined ? { correlation_id: inbound.correlation_id } : {}),
    body,
    created_at: new Date().toISOString(),
  };
}

export function envelopeRefs(envelope: Envelope): string[] {
  const replyTo = envelope.reply_to ?? envelope.from;
  const refs = [
    `${REF_REPLY_TO}${formatAddress(replyTo)}`,
    `${REF_FROM}${formatAddress(envelope.from)}`,
    `${REF_ENVELOPE_ID}${envelope.id}`,
  ];
  if (envelope.correlation_id !== undefined) {
    refs.push(`${REF_CORRELATION}${envelope.correlation_id}`);
  }
  return refs;
}

function refValue(refs: string[] | undefined, prefix: string): string | undefined {
  const hit = refs?.find((ref) => ref.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

export function correlationSlug(correlationId: string): string {
  const slug = correlationId
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 127);
  return slug || 'mailbox';
}

/**
 * Hub messages on main still use {to, thread, subject, body, refs, ts}.
 * Prefer `toEnvelope` from `src/protocol.ts` when the log already stores
 * vendor addresses. This fallback reads refs until that lands.
 */
export function envelopeFromHubMessage(
  message: {
    id: string;
    from: string;
    to: string;
    body: string;
    thread?: string;
    in_reply_to?: string;
    refs?: string[];
    ts?: string;
    reply_to?: string;
    correlation_id?: string;
  },
  self: Address
): Envelope {
  const from =
    parseAddress(refValue(message.refs, REF_FROM) ?? message.from) ??
    parseAddress(message.from) ??
    addr('agent', message.from);
  const replyRaw = refValue(message.refs, REF_REPLY_TO) ?? message.reply_to ?? message.from;
  const reply_to = parseAddress(replyRaw) ?? addr('agent', replyRaw);
  const correlation =
    refValue(message.refs, REF_CORRELATION) ?? message.correlation_id ?? message.thread ?? message.id;
  return {
    id: message.id,
    from,
    to: self,
    reply_to,
    correlation_id: correlation,
    body: message.body,
    created_at: message.ts ?? new Date().toISOString(),
  };
}

/** Accept hub Address objects or `vendor:thread_id` strings on the local HTTP wrapper. */
export function coerceAddress(value: unknown): Address | undefined {
  if (typeof value === 'string') return parseAddress(value);
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as { vendor?: unknown; thread_id?: unknown; threadId?: unknown };
  if (typeof rec.vendor !== 'string') return undefined;
  const thread_id = rec.thread_id ?? rec.threadId;
  if (typeof thread_id !== 'string' || !thread_id) return undefined;
  return parseAddress(`${rec.vendor}:${thread_id}`) ?? { vendor: rec.vendor, thread_id };
}

export function coerceEnvelope(raw: unknown): Envelope {
  if (!raw || typeof raw !== 'object') throw new Error('invalid envelope');
  const rec = raw as Record<string, unknown>;
  const from = coerceAddress(rec['from']);
  const to = coerceAddress(rec['to']);
  if (!from || !to) throw new Error('envelope from/to must be vendor:thread_id');
  if (typeof rec['body'] !== 'string' || !rec['body']) throw new Error('envelope body is required');
  const reply_to = rec['reply_to'] !== undefined ? coerceAddress(rec['reply_to']) : undefined;
  return {
    id: typeof rec['id'] === 'string' && rec['id'] ? rec['id'] : newEnvelopeId(),
    from,
    to,
    ...(reply_to !== undefined ? { reply_to } : {}),
    ...(typeof rec['correlation_id'] === 'string' ? { correlation_id: rec['correlation_id'] } : {}),
    body: rec['body'],
    created_at: typeof rec['created_at'] === 'string' ? rec['created_at'] : new Date().toISOString(),
  };
}
