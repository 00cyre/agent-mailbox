import { KNOWN_VENDORS, type Envelope, type Vendor } from './protocol.js';

/**
 * How the hub talks to a vendor.
 *
 * `send(threadId, envelope)` is a native send-to-thread: the hub has already
 * routed on `to.vendor`, and `threadId` is `to.thread_id`. A real adapter
 * posts into that conversation through the vendor's own API. This package
 * ships stubs — sibling workers own Claude / Cursor / Grok / Codex / ChatGPT.
 *
 * Listen and ack are not a second protocol. They are the mailbox the hub
 * already has: `GET /v1/inbox?cursor=N&wait=…` (or `MailStore.wait`). The
 * cursor is the ack. In-process adapters are pushed via `send` and do not
 * need to poll; out-of-process adapters long-poll the inbox for their vendor.
 */
export interface VendorAdapter {
  readonly vendor: Vendor;
  send(threadId: string, envelope: Envelope): Promise<void>;
}

export interface Delivery {
  threadId: string;
  envelope: Envelope;
}

/**
 * Records deliveries and does not talk to a vendor. Replaced by `register()`
 * when a real adapter is attached; until then the store still queues the mail
 * so a polling sibling can pick it up.
 */
export class StubAdapter implements VendorAdapter {
  readonly vendor: Vendor;
  readonly sent: Delivery[] = [];

  constructor(vendor: Vendor) {
    this.vendor = vendor;
  }

  async send(threadId: string, envelope: Envelope): Promise<void> {
    this.sent.push({ threadId, envelope });
  }
}

export class AdapterRegistry {
  readonly #byVendor = new Map<string, VendorAdapter>();

  static withStubs(vendors: readonly string[] = KNOWN_VENDORS): AdapterRegistry {
    const registry = new AdapterRegistry();
    for (const vendor of vendors) registry.register(new StubAdapter(vendor));
    return registry;
  }

  register(adapter: VendorAdapter): void {
    this.#byVendor.set(adapter.vendor, adapter);
  }

  get(vendor: string): VendorAdapter | undefined {
    return this.#byVendor.get(vendor);
  }

  list(): VendorAdapter[] {
    return [...this.#byVendor.values()];
  }

  /**
   * Push into the adapter for `to.vendor`. Unknown vendors get a stub so an
   * extension does not require a hub change — the message is still in the log.
   */
  async deliver(threadId: string, envelope: Envelope): Promise<void> {
    const vendor = envelope.to.vendor;
    let adapter = this.#byVendor.get(vendor);
    if (!adapter) {
      adapter = new StubAdapter(vendor);
      this.#byVendor.set(vendor, adapter);
    }
    await adapter.send(threadId, envelope);
  }
}
