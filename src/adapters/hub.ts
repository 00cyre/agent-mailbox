import { correlationSlug, envelopeFromHubMessage, envelopeRefs } from './format.js';
import { formatAddress, type Address, type Envelope } from '../protocol.js';
import type { Message } from '../types.js';

export interface HubClientOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class HubClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: HubClientOptions) {
    this.#url = options.url.replace(/\/+$/u, '');
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async whoami(): Promise<{ agent: { id: string }; head: number }> {
    return this.#api('/v1/whoami') as Promise<{ agent: { id: string }; head: number }>;
  }

  async register(name: string): Promise<{ slug: string; name: string }> {
    return this.#api('/v1/chats', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }) as Promise<{ slug: string; name: string }>;
  }

  async sendEnvelope(
    envelope: Envelope,
    extra: { type?: 'message' | 'reply' | 'request' | 'ack'; in_reply_to?: string } = {}
  ): Promise<Message> {
    const to = hubWireAddress(envelope.to);
    const correlation = envelope.correlation_id ?? envelope.id;
    const fromWire = hubWireAddress(envelope.from);
    const replyWire = envelope.reply_to ? hubWireAddress(envelope.reply_to) : undefined;
    return this.#api('/v1/send', {
      method: 'POST',
      body: JSON.stringify({
        to,
        body: envelope.body,
        type: extra.type ?? 'message',
        thread: correlationSlug(correlation),
        subject: `mailbox ${correlation}`.slice(0, 200),
        ...(extra.in_reply_to !== undefined ? { in_reply_to: extra.in_reply_to } : {}),
        ...(replyWire !== undefined ? { reply_to: replyWire } : {}),
        ...(envelope.correlation_id !== undefined ? { correlation_id: envelope.correlation_id } : {}),
        ...(envelope.from.vendor !== 'agent' ? { from: fromWire } : {}),
        refs: envelopeRefs(envelope),
      }),
    }) as Promise<Message>;
  }

  async inbox(
    cursor: number,
    waitMs: number,
    chat?: string
  ): Promise<{ data: Message[]; cursor: number }> {
    const params = new URLSearchParams({
      wait: String(waitMs),
      cursor: String(cursor),
    });
    if (chat) params.set('chat', chat);
    return this.#api(`/v1/inbox?${params}`) as Promise<{ data: Message[]; cursor: number }>;
  }

  inboundEnvelope(message: Message, self: Address): Envelope {
    return envelopeFromHubMessage(message, self);
  }

  async #api(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#fetch(`${this.#url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
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
}

function hubWireAddress(address: Address): string {
  // Fallback when the current hub still addresses agents by id, not vendor:thread.
  if (address.vendor === 'agent') return address.thread_id;
  return formatAddress(address);
}
