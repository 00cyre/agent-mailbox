import type { Envelope, SendResult } from '../protocol.js';
import { buildReplyEnvelope, parseAddress } from '../protocol.js';
import { ClaudeAdapter } from './adapter.js';
import { envelopeToLegacySendMessage, envelopeToSendMessage, mailboxMessageToEnvelope } from './envelope.js';
import { normalizeClaudeThreadId } from './format.js';
import type { Message } from '../../types.js';

export interface HubClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

export class HubClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: HubClientOptions) {
    this.#url = options.url.replace(/\/+$/u, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async request(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const response = await this.#fetch(`${this.#url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as unknown;
    return { status: response.status, body };
  }

  async whoami(): Promise<{ head: number }> {
    const { status, body } = await this.request('/v1/whoami');
    if (status !== 200) throw new Error(`whoami ${status}`);
    return body as { head: number };
  }

  async inbox(cursor: number, wait: number, extra: Record<string, string> = {}): Promise<{
    data: Message[];
    cursor: number;
  }> {
    const params = new URLSearchParams({ cursor: String(cursor), wait: String(wait), ...extra });
    const { status, body } = await this.request(`/v1/inbox?${params}`);
    if (status !== 200) {
      const err = body as { error?: { message?: string } };
      throw new Error(`inbox ${status}: ${err.error?.message ?? JSON.stringify(body)}`);
    }
    return body as { data: Message[]; cursor: number };
  }

  async sendEnvelope(envelope: Envelope): Promise<unknown> {
    const primary = envelopeToSendMessage(envelope);
    let { status, body } = await this.request('/v1/send', {
      method: 'POST',
      body: JSON.stringify(primary),
    });
    if (status === 404) {
      const legacy = envelopeToLegacySendMessage(envelope);
      ({ status, body } = await this.request('/v1/send', {
        method: 'POST',
        body: JSON.stringify(legacy),
      }));
    }
    if (status >= 400) {
      const err = body as { error?: { message?: string } };
      throw new Error(`send ${status}: ${err.error?.message ?? JSON.stringify(body)}`);
    }
    return body;
  }
}

/**
 * Long-poll the hub and deliver every Claude-bound message into a thread.
 * Replies captured by a transport (code-cli) are posted back with the inbound
 * `reply_to` / `correlation_id` preserved.
 */
export async function bridgeLoop(options: {
  hub: HubClient;
  adapter: ClaudeAdapter;
  threadId?: string;
  cursor?: number;
  waitMs?: number;
  onDelivered?: (envelope: Envelope, result: SendResult) => void;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const waitMs = options.waitMs ?? 120_000;
  let cursor = options.cursor;
  if (cursor === undefined) {
    const who = await options.hub.whoami();
    cursor = who.head;
  }

  while (!options.abortSignal?.aborted) {
    try {
      const extra: Record<string, string> = {};
      if (options.threadId) extra['thread'] = options.threadId;
      const result = await options.hub.inbox(cursor, waitMs, extra);
      cursor = result.cursor;
      for (const message of result.data) {
        const bound = options.threadId ?? threadIdFromMessage(message);
        const envelope = mailboxMessageToEnvelope(message, bound);
        const dest = envelope.to;
        if (dest.vendor !== 'claude') continue;
        const sendResult = await options.adapter.deliver(bound, envelope);
        options.onDelivered?.(envelope, sendResult);
        if (sendResult.replyBody) {
          const reply = buildReplyEnvelope({
            threadId: bound,
            inbound: envelope,
            body: sendResult.replyBody,
          });
          await options.hub.sendEnvelope(reply);
        }
      }
    } catch (error) {
      if (options.abortSignal?.aborted) return;
      process.stderr.write(`claude-bridge: ${error instanceof Error ? error.message : String(error)}\n`);
      await sleep(3_000, options.abortSignal);
    }
  }
}

export function threadIdFromMessage(message: Pick<Message, 'to' | 'thread'>): string {
  const dest = parseAddress(message.to);
  if (dest?.vendor === 'claude') return dest.thread_id;
  return normalizeClaudeThreadId(message.to) || message.thread;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
