import type { Message, SendMessage } from '../../types.js';
import {
  envelopeSchema,
  formatAddress,
  inferVendor,
  parseAddress,
  type Envelope,
} from '../protocol.js';
import { normalizeClaudeThreadId } from './format.js';

/**
 * Map a stored mailbox Message onto the n-to-n envelope. Namespaced
 * `vendor:thread` fields pass through; classic agent-id / chat-slug mail is
 * wrapped so the Claude adapter still has a return address.
 */
export function mailboxMessageToEnvelope(
  message: Pick<Message, 'id' | 'from' | 'to' | 'thread' | 'body' | 'ts'> & {
    subject?: string;
    in_reply_to?: string;
    reply_to?: string;
    correlation_id?: string;
  },
  claudeThreadId?: string
): Envelope {
  const from =
    parseAddress(message.from) ??
    ({
      vendor: inferVendor(message.from) ?? message.from,
      thread_id: message.thread,
    } as const);
  const to =
    parseAddress(message.to) ??
    ({
      vendor: 'claude',
      thread_id: claudeThreadId ?? normalizeClaudeThreadId(message.to),
    } as const);
  const replyParsed =
    message.reply_to !== undefined ? parseAddress(message.reply_to) : undefined;
  const body =
    message.subject && message.subject.trim().length > 0
      ? `**${message.subject.trim()}**\n\n${message.body}`
      : message.body;
  return {
    id: message.id,
    from,
    to,
    reply_to: replyParsed ?? from,
    correlation_id: message.correlation_id ?? message.in_reply_to ?? message.id,
    body,
    created_at: message.ts,
  };
}

export function envelopeToSendMessage(envelope: Envelope): SendMessage {
  const payload: SendMessage = {
    to: formatAddress(envelope.to),
    thread: slugForHub(envelope.to.thread_id),
    subject: subjectFor(envelope),
    body: envelope.body,
    type: envelope.correlation_id ? 'reply' : 'message',
  };
  const replyRef = envelope.correlation_id ?? envelope.id;
  payload.in_reply_to = replyRef.slice(0, 128);
  return payload;
}

/** Older hubs reject `to: "grok:X"` — retry as vendor id + thread. */
export function envelopeToLegacySendMessage(envelope: Envelope): SendMessage {
  const payload: SendMessage = {
    to: envelope.to.vendor,
    thread: slugForHub(envelope.to.thread_id),
    subject: subjectFor(envelope),
    body: envelope.body,
    type: envelope.correlation_id ? 'reply' : 'message',
  };
  const replyRef = envelope.correlation_id ?? envelope.id;
  payload.in_reply_to = replyRef.slice(0, 128);
  return payload;
}

export function parseEnvelope(input: unknown): Envelope {
  return envelopeSchema.parse(input);
}

export function destinationThreadId(envelope: Envelope): string {
  return envelope.to.thread_id;
}

function subjectFor(envelope: Envelope): string {
  const raw = envelope.correlation_id ? `re:${envelope.correlation_id}` : 'message';
  return raw.slice(0, 200);
}

function slugForHub(threadId: string): string {
  const slug = threadId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 128);
  return slug.length > 0 ? slug : 'claude';
}
