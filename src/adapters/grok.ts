import {
  createEnvelope,
  formatAddress,
  replyEnvelope,
  type Envelope,
  type ReceiveResult,
  type SendResult,
  type VendorAdapter,
} from './protocol.js';
import { formatForThread } from './format.js';
import { grokBotPaste, grokSafariSend, requireDarwin } from './macos.js';
import { runCommand, type RunCommand } from './process.js';

export interface GrokAdapterOptions {
  apiKey?: string;
  apiBase?: string;
  model?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  runCommand?: RunCommand;
  sleep?: (ms: number) => Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RESPONSE_ID = /^(resp_|rs_)/u;
const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Pending {
  envelope: Envelope;
  nativeId?: string;
  seen: boolean;
}

export function isGrokWebId(threadId: string): boolean {
  return UUID.test(threadId);
}

export function isXaiResponseId(threadId: string): boolean {
  return RESPONSE_ID.test(threadId);
}

export class GrokAdapter implements VendorAdapter {
  readonly vendor = 'grok' as const;
  readonly #apiKey: string | undefined;
  readonly #apiBase: string;
  readonly #model: string;
  readonly #platform: NodeJS.Platform;
  readonly #fetch: typeof fetch;
  readonly #run: RunCommand;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pending = new Map<string, Pending[]>();
  readonly #heads = new Map<string, string>();
  readonly #queued = new Map<string, Envelope[]>();
  readonly #emitted = new Set<string>();

  constructor(options: GrokAdapterOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env['XAI_API_KEY'];
    this.#apiBase = (options.apiBase ?? process.env['XAI_API_BASE'] ?? 'https://api.x.ai/v1').replace(
      /\/+$/u,
      ''
    );
    this.#model = options.model ?? process.env['XAI_MODEL'] ?? 'grok-4.6';
    this.#platform = options.platform ?? process.platform;
    this.#fetch = options.fetch ?? fetch;
    this.#run = options.runCommand ?? runCommand;
    this.#sleep = options.sleep ?? sleepDefault;
  }

  async send(threadId: string, envelope: Envelope): Promise<SendResult> {
    const text = formatForThread(envelope);
    if (threadId.startsWith('grokbot:') || threadId.startsWith('bot:')) {
      requireDarwin(this.#platform, 'Grok Bot Mac wrapper');
      await grokBotPaste(text, this.#run);
      this.#remember(threadId, envelope, 'grokbot');
      return { envelope, transport: 'grokbot', nativeId: threadId };
    }
    if (isGrokWebId(threadId) || threadId.startsWith('web:')) {
      requireDarwin(this.#platform, 'grok.com Safari wrapper');
      const id = threadId.startsWith('web:') ? threadId.slice(4) : threadId;
      const reply = await grokSafariSend(id, text, this.#run);
      this.#remember(threadId, envelope, id);
      if (reply) this.#queueReply(threadId, envelope, reply);
      return { envelope, transport: 'grok.com', nativeId: id };
    }
    if (!this.#apiKey) {
      throw new Error(
        'no Grok transport for this thread. Set XAI_API_KEY for the Responses API ' +
          '(thread id = previous_response_id), or run on macOS for grok.com chat UUIDs.'
      );
    }
    const previous = this.#heads.get(threadId) ?? (isXaiResponseId(threadId) ? threadId : undefined);
    this.#remember(threadId, envelope, previous);
    const nativeId = await this.#xaiSend(threadId, text, previous);
    this.#heads.set(threadId, nativeId);
    return { envelope, transport: 'xai', nativeId };
  }

  async receive(threadId: string, cursor?: string | undefined, waitMs = 0): Promise<ReceiveResult> {
    const queued = this.#queued.get(threadId) ?? [];
    if (queued.length > 0) {
      this.#queued.set(threadId, []);
      return { envelopes: queued, cursor: queued.at(-1)?.id ?? cursor ?? '0' };
    }

    const head = this.#heads.get(threadId);
    if (this.#apiKey && (head || isXaiResponseId(threadId))) {
      return this.#xaiReceive(threadId, cursor, waitMs);
    }

    if (waitMs > 0) await this.#sleep(Math.min(waitMs, 3_000));
    const later = this.#queued.get(threadId) ?? [];
    this.#queued.set(threadId, []);
    return { envelopes: later, cursor: cursor ?? '0' };
  }

  #remember(threadId: string, envelope: Envelope, nativeId?: string): void {
    const list = this.#pending.get(threadId) ?? [];
    const item: Pending = { envelope, seen: false };
    if (nativeId !== undefined) item.nativeId = nativeId;
    list.push(item);
    this.#pending.set(threadId, list);
  }

  #queueReply(threadId: string, original: Envelope, body: string): void {
    const list = this.#queued.get(threadId) ?? [];
    list.push(replyEnvelope(original, body, formatAddress('grok', threadId)));
    this.#queued.set(threadId, list);
  }

  async #xaiSend(threadId: string, input: string, previousResponseId?: string): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.#model,
      input,
    };
    if (previousResponseId) payload['previous_response_id'] = previousResponseId;
    const response = await this.#api('/responses', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`xAI Responses ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const id = typeof body['id'] === 'string' ? body['id'] : undefined;
    if (!id) throw new Error('xAI response had no id');
    const text = extractXaiText(body);
    if (text && !this.#emitted.has(id)) {
      this.#emitted.add(id);
      const original = this.#pending.get(threadId)?.find((p) => !p.seen);
      if (original) {
        original.seen = true;
        original.nativeId = id;
        this.#queueReply(threadId, original.envelope, text);
      }
    }
    return id;
  }

  async #xaiReceive(threadId: string, cursor: string | undefined, waitMs: number): Promise<ReceiveResult> {
    const id = this.#heads.get(threadId) ?? threadId;
    const deadline = Date.now() + Math.max(waitMs, 0);
    for (;;) {
      const queued = this.#queued.get(threadId) ?? [];
      if (queued.length > 0) {
        this.#queued.set(threadId, []);
        return { envelopes: queued, cursor: id };
      }
      const response = await this.#api(`/responses/${encodeURIComponent(id)}`);
      if (response.ok) {
        const body = (await response.json()) as Record<string, unknown>;
        const text = extractXaiText(body);
        if (text && !this.#emitted.has(id)) {
          this.#emitted.add(id);
          const original = this.#pending.get(threadId)?.find((p) => !p.seen);
          if (original) {
            original.seen = true;
            return {
              envelopes: [replyEnvelope(original.envelope, text, formatAddress('grok', threadId))],
              cursor: id,
            };
          }
          if (id !== cursor) {
            return {
              envelopes: [
                createEnvelope({
                  from: formatAddress('grok', threadId),
                  to: formatAddress('grok', threadId),
                  reply_to: formatAddress('grok', threadId),
                  correlation_id: id,
                  body: text,
                }),
              ],
              cursor: id,
            };
          }
        }
      }
      if (Date.now() >= deadline || waitMs <= 0) return { envelopes: [], cursor: cursor ?? id };
      await this.#sleep(Math.min(2_000, Math.max(deadline - Date.now(), 1)));
    }
  }

  async #api(path: string, init: RequestInit = {}): Promise<Response> {
    const key = this.#apiKey;
    if (!key) throw new Error('XAI_API_KEY is not set');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return this.#fetch(`${this.#apiBase}${suffix}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }
}

export function extractXaiText(payload: Record<string, unknown>): string | undefined {
  if (typeof payload['output_text'] === 'string' && payload['output_text']) {
    return payload['output_text'];
  }
  const output = payload['output'];
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const content = rec['content'];
    if (!Array.isArray(content)) continue;
    for (const chunk of content) {
      if (!chunk || typeof chunk !== 'object') continue;
      const c = chunk as Record<string, unknown>;
      if (c['type'] === 'output_text' && typeof c['text'] === 'string') parts.push(c['text']);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}
