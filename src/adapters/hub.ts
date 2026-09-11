import {
  createEnvelope,
  isVendor,
  parseAddress,
  type Envelope,
  type SendResult,
  type VendorAdapter,
} from './protocol.js';

import { CursorAdapter, type CursorAdapterOptions } from './cursor.js';
import { GrokAdapter, type GrokAdapterOptions } from './grok.js';

export function defaultAdapterHub(options: {
  cursor?: CursorAdapterOptions;
  grok?: GrokAdapterOptions;
} = {}): AdapterHub {
  return new AdapterHub()
    .register(new CursorAdapter(options.cursor))
    .register(new GrokAdapter(options.grok));
}

export class AdapterHub {
  readonly #adapters = new Map<string, VendorAdapter>();

  register(adapter: VendorAdapter): this {
    this.#adapters.set(adapter.vendor, adapter);
    return this;
  }

  get(vendor: string): VendorAdapter | undefined {
    return this.#adapters.get(vendor);
  }

  has(vendor: string): boolean {
    return this.#adapters.has(vendor);
  }

  async send(envelope: Envelope): Promise<SendResult> {
    const dest = parseAddress(envelope.to);
    const adapter = this.#adapters.get(dest.vendor);
    if (!adapter) {
      throw new Error(
        `no adapter registered for vendor "${dest.vendor}" — known: ${[...this.#adapters.keys()].join(', ') || '(none)'}`
      );
    }
    return adapter.send(dest.threadId, envelope);
  }

  async receive(address: string, cursor?: string | undefined, waitMs?: number) {
    const dest = parseAddress(address);
    const adapter = this.#adapters.get(dest.vendor);
    if (!adapter) {
      throw new Error(`no adapter registered for vendor "${dest.vendor}"`);
    }
    return adapter.receive(dest.threadId, cursor, waitMs);
  }

  /**
   * If `reply_to` is a vendor we own, inject there. Otherwise the caller
   * (mailbox hub) must forward it.
   */
  async deliverIfLocal(envelope: Envelope): Promise<SendResult | undefined> {
    const dest = parseAddress(envelope.to);
    if (!this.#adapters.has(dest.vendor)) return undefined;
    return this.send(envelope);
  }
}

export function assertKnownVendor(vendor: string): void {
  if (!isVendor(vendor)) {
    throw new Error(`this process only serves cursor and grok (got "${vendor}")`);
  }
}

export function envelopeFromSendBody(body: unknown): Envelope {
  if (!body || typeof body !== 'object') throw new Error('JSON object required');
  const rec = body as Record<string, unknown>;
  const to = typeof rec['to'] === 'string' ? rec['to'] : undefined;
  const from = typeof rec['from'] === 'string' ? rec['from'] : undefined;
  const text = typeof rec['body'] === 'string' ? rec['body'] : undefined;
  if (!to || !from || !text) throw new Error('from, to and body are required');
  return createEnvelope({
    from,
    to,
    body: text,
    ...(typeof rec['reply_to'] === 'string' ? { reply_to: rec['reply_to'] } : {}),
    ...(typeof rec['correlation_id'] === 'string' ? { correlation_id: rec['correlation_id'] } : {}),
    ...(typeof rec['id'] === 'string' ? { id: rec['id'] } : {}),
    ...(typeof rec['created_at'] === 'string' ? { created_at: rec['created_at'] } : {}),
  });
}
