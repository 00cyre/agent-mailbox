import { CursorAdapter, type CursorAdapterOptions } from './cursor.js';
import { GrokAdapter, type GrokAdapterOptions } from './grok.js';
import {
  createEnvelope,
  formatAddress,
  parseAddress,
  type AdapterSendResult,
  type Envelope,
  type ListeningVendorAdapter,
  type ReceiveResult,
} from './protocol.js';

export function defaultAdapterHub(
  options: {
    cursor?: CursorAdapterOptions;
    grok?: GrokAdapterOptions;
  } = {}
): AdapterHub {
  return new AdapterHub()
    .register(new CursorAdapter(options.cursor))
    .register(new GrokAdapter(options.grok));
}

/**
 * In-process dispatcher for the Cursor + Grok loopback HTTP face.
 * The mailbox hub uses `AdapterRegistry`; this is only `adapter serve`.
 */
export class AdapterHub {
  readonly #adapters = new Map<string, ListeningVendorAdapter>();

  register(adapter: ListeningVendorAdapter): this {
    this.#adapters.set(adapter.vendor, adapter);
    return this;
  }

  get(vendor: string): ListeningVendorAdapter | undefined {
    return this.#adapters.get(vendor);
  }

  has(vendor: string): boolean {
    return this.#adapters.has(vendor);
  }

  async send(envelope: Envelope): Promise<AdapterSendResult> {
    const dest = envelope.to;
    const adapter = this.#adapters.get(dest.vendor);
    if (!adapter) {
      throw new Error(
        `no adapter registered for vendor "${dest.vendor}" — known: ${[...this.#adapters.keys()].join(', ') || '(none)'}`
      );
    }
    if (adapter.deliver) return adapter.deliver(dest.thread_id, envelope);
    await adapter.send(dest.thread_id, envelope);
    return { envelope, transport: adapter.vendor };
  }

  async receive(address: string, cursor?: string | undefined, waitMs?: number): Promise<ReceiveResult> {
    const dest = parseAddress(address);
    if (!dest) throw new Error(`address must be "{vendor}:{thread_id}" (got ${JSON.stringify(address)})`);
    const adapter = this.#adapters.get(dest.vendor);
    if (!adapter?.receive) {
      throw new Error(`no adapter registered for vendor "${dest.vendor}"`);
    }
    return adapter.receive(dest.thread_id, cursor, waitMs);
  }

  async deliverIfLocal(envelope: Envelope): Promise<AdapterSendResult | undefined> {
    if (!this.#adapters.has(envelope.to.vendor)) return undefined;
    return this.send(envelope);
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

export function wireEnvelope(envelope: Envelope): Record<string, string | undefined> {
  return {
    id: envelope.id,
    from: formatAddress(envelope.from),
    to: formatAddress(envelope.to),
    reply_to: envelope.reply_to ? formatAddress(envelope.reply_to) : undefined,
    correlation_id: envelope.correlation_id,
    body: envelope.body,
    created_at: envelope.created_at,
  };
}
