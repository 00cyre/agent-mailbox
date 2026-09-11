import type { Envelope, ReceiveResult, AdapterSendResult, ListeningVendorAdapter } from './protocol.js';
import { formatForThread, replyEnvelope } from './format.js';
import {
  cursorDesktopSend,
  cursorOpenCloud,
  openUrl,
  requireDarwin,
} from './macos.js';
import { runCommand, which, type RunCommand } from './process.js';

export interface CursorAdapterOptions {
  apiKey?: string;
  apiBase?: string;
  agentBin?: string;
  cursorBin?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  runCommand?: RunCommand;
  sleep?: (ms: number) => Promise<void>;
  /** When a cloud run is busy, retry this many times. */
  busyRetries?: number;
}

const CLOUD_ID = /^(bc[-_])/u;
const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Pending {
  envelope: Envelope;
  nativeId?: string;
  seen: boolean;
}

export function isCursorCloudId(threadId: string): boolean {
  return CLOUD_ID.test(threadId);
}

export class CursorAdapter implements ListeningVendorAdapter {
  readonly vendor = 'cursor' as const;
  readonly #apiKey: string | undefined;
  readonly #apiBase: string;
  readonly #agentBin: string;
  readonly #cursorBin: string;
  readonly #platform: NodeJS.Platform;
  readonly #fetch: typeof fetch;
  readonly #run: RunCommand;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #busyRetries: number;
  readonly #pending = new Map<string, Pending[]>();
  readonly #seenRuns = new Map<string, Set<string>>();
  readonly #conversationIndex = new Map<string, number>();

  constructor(options: CursorAdapterOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env['CURSOR_API_KEY'];
    this.#apiBase = (options.apiBase ?? process.env['CURSOR_API_BASE'] ?? 'https://api.cursor.com').replace(
      /\/+$/u,
      ''
    );
    this.#agentBin = options.agentBin ?? process.env['CURSOR_AGENT_BIN'] ?? 'agent';
    this.#cursorBin = options.cursorBin ?? process.env['CURSOR_BIN'] ?? 'cursor';
    this.#platform = options.platform ?? process.platform;
    this.#fetch = options.fetch ?? fetch;
    this.#run = options.runCommand ?? runCommand;
    this.#sleep = options.sleep ?? sleepDefault;
    this.#busyRetries = options.busyRetries ?? 8;
  }

  async send(threadId: string, envelope: Envelope): Promise<void> {
    await this.deliver(threadId, envelope);
  }

  async deliver(threadId: string, envelope: Envelope): Promise<AdapterSendResult> {
    const text = formatForThread(envelope);
    if (isCursorCloudId(threadId) && this.#apiKey) {
      const nativeId = await this.#cloudFollowup(threadId, text);
      this.#remember(threadId, envelope, nativeId);
      return { envelope, transport: 'cloud', nativeId };
    }
    if (await which(this.#agentBin, this.#run)) {
      const stdout = await this.#cliSend(threadId, text);
      this.#remember(threadId, envelope, 'cli');
      if (stdout.trim()) this.#stashCliReply(threadId, envelope, stdout.trim());
      return { envelope, transport: 'cli', nativeId: threadId };
    }
    requireDarwin(this.#platform, 'Cursor desktop wrapper');
    return this.#desktopSend(threadId, envelope, text);
  }

  async receive(threadId: string, cursor?: string | undefined, waitMs = 0): Promise<ReceiveResult> {
    if (isCursorCloudId(threadId) && this.#apiKey) {
      return this.#cloudReceive(threadId, cursor, waitMs);
    }
    const queued = this.#takePendingReplies(threadId);
    if (queued.length > 0) return { envelopes: queued, cursor: cursor ?? '0' };
    if (waitMs > 0) await this.#sleep(Math.min(waitMs, 3_000));
    return { envelopes: this.#takePendingReplies(threadId), cursor: cursor ?? '0' };
  }

  #remember(threadId: string, envelope: Envelope, nativeId?: string): void {
    const list = this.#pending.get(threadId) ?? [];
    const item: Pending = { envelope, seen: false };
    if (nativeId !== undefined) item.nativeId = nativeId;
    list.push(item);
    this.#pending.set(threadId, list);
  }

  #stashCliReply(threadId: string, original: Envelope, body: string): void {
    const list = this.#pending.get(threadId) ?? [];
    list.push({
      envelope: replyEnvelope(original, body, { vendor: 'cursor', thread_id: threadId }),
      seen: false,
      nativeId: 'cli-reply',
    });
    this.#pending.set(threadId, list);
  }

  #takePendingReplies(threadId: string): Envelope[] {
    const list = this.#pending.get(threadId) ?? [];
    const out: Envelope[] = [];
    for (const item of list) {
      if (item.seen) continue;
      if (item.nativeId === 'cli-reply') {
        item.seen = true;
        out.push(item.envelope);
      }
    }
    return out;
  }

  async #cloudFollowup(agentId: string, text: string): Promise<string> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= this.#busyRetries; attempt += 1) {
      const response = await this.#api(`/v1/agents/${encodeURIComponent(agentId)}/runs`, {
        method: 'POST',
        body: JSON.stringify({ prompt: { text } }),
      });
      if (response.status === 409) {
        lastErr = new Error(`cursor agent ${agentId} is busy`);
        await this.#sleep(1_500 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        throw new Error(`Cursor Cloud Agents ${response.status}: ${await response.text()}`);
      }
      const payload = (await response.json()) as { run?: { id?: string }; id?: string };
      const id = payload.run?.id ?? payload.id;
      if (!id) throw new Error('Cursor Cloud Agents follow-up returned no run id');
      return id;
    }
    throw lastErr ?? new Error(`cursor agent ${agentId} stayed busy`);
  }

  async #cloudReceive(threadId: string, cursor: string | undefined, waitMs: number): Promise<ReceiveResult> {
    const deadline = Date.now() + Math.max(waitMs, 0);
    for (;;) {
      const fromConversation = await this.#tryConversation(threadId);
      if (fromConversation.envelopes.length > 0) {
        return { envelopes: fromConversation.envelopes, cursor: fromConversation.cursor };
      }
      const fromRuns = await this.#fromRuns(threadId);
      if (fromRuns.length > 0) return { envelopes: fromRuns, cursor: cursor ?? fromRuns.at(-1)?.id ?? '0' };
      if (Date.now() >= deadline) return { envelopes: [], cursor: cursor ?? '0' };
      await this.#sleep(Math.min(2_000, Math.max(deadline - Date.now(), 0) || 0));
      if (waitMs <= 0) return { envelopes: [], cursor: cursor ?? '0' };
    }
  }

  async #tryConversation(threadId: string): Promise<ReceiveResult> {
    const response = await this.#api(`/v0/agents/${encodeURIComponent(threadId)}/conversation`);
    if (!response.ok) return { envelopes: [], cursor: String(this.#conversationIndex.get(threadId) ?? 0) };
    const payload = (await response.json()) as {
      messages?: { id?: string; type?: string; text?: string }[];
    };
    const messages = payload.messages ?? [];
    const start = this.#conversationIndex.get(threadId) ?? 0;
    const fresh = messages.slice(start);
    this.#conversationIndex.set(threadId, messages.length);
    const pending = this.#pending.get(threadId) ?? [];
    const envelopes: Envelope[] = [];
    for (const message of fresh) {
      if (message.type !== 'assistant_message' || !message.text) continue;
      const original = pending.find((p) => !p.seen);
      if (original) {
        original.seen = true;
        envelopes.push(replyEnvelope(original.envelope, message.text, { vendor: 'cursor', thread_id: threadId }));
      } else {
        envelopes.push(
          replyEnvelope(
            {
              id: message.id ?? 'cursor-msg',
              from: { vendor: 'cursor', thread_id: threadId },
              to: { vendor: 'cursor', thread_id: threadId },
              reply_to: { vendor: 'cursor', thread_id: threadId },
              correlation_id: message.id ?? 'cursor-msg',
              body: message.text,
              created_at: new Date().toISOString(),
            },
            message.text,
            { vendor: 'cursor', thread_id: threadId }
          )
        );
        // Organic assistant text with no inbound envelope: report as from this thread
        // to itself so a hub can still see it; routing stays on reply_to of real mail.
      }
    }
    return { envelopes, cursor: String(messages.length) };
  }

  async #fromRuns(threadId: string): Promise<Envelope[]> {
    const response = await this.#api(`/v1/agents/${encodeURIComponent(threadId)}/runs?limit=20`);
    if (!response.ok) return [];
    const payload = (await response.json()) as { items?: { id: string; status: string }[] };
    const seen = this.#seenRuns.get(threadId) ?? new Set<string>();
    const envelopes: Envelope[] = [];
    const pending = this.#pending.get(threadId) ?? [];
    for (const run of payload.items ?? []) {
      if (seen.has(run.id) || run.status !== 'FINISHED') continue;
      const detail = await this.#api(
        `/v1/agents/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(run.id)}`
      );
      if (!detail.ok) continue;
      const body = (await detail.json()) as { result?: string };
      if (!body.result) continue;
      seen.add(run.id);
      const original =
        pending.find((p) => p.nativeId === run.id && !p.seen) ?? pending.find((p) => !p.seen);
      if (original) original.seen = true;
      const from = { vendor: 'cursor', thread_id: threadId };
      envelopes.push(
        original
          ? replyEnvelope(original.envelope, body.result, from)
          : replyEnvelope(
              {
                id: run.id,
                from,
                to: from,
                reply_to: from,
                correlation_id: run.id,
                body: body.result,
                created_at: new Date().toISOString(),
              },
              body.result,
              from
            )
      );
    }
    this.#seenRuns.set(threadId, seen);
    return envelopes;
  }

  async #cliSend(threadId: string, text: string): Promise<string> {
    const result = await this.#run(
      this.#agentBin,
      ['--resume', threadId, '-p', '--force', '--output-format', 'text', text],
      { timeoutMs: 300_000 }
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `${this.#agentBin} --resume failed (${result.code})`);
    }
    return result.stdout;
  }

  async #desktopSend(threadId: string, envelope: Envelope, text: string): Promise<AdapterSendResult> {
    try {
      await cursorDesktopSend(threadId, text, this.#run, this.#cursorBin);
      this.#remember(threadId, envelope, 'desktop');
      return { envelope, transport: 'desktop-bridge', nativeId: threadId };
    } catch (desktopErr) {
      if (isCursorCloudId(threadId)) {
        await cursorOpenCloud(threadId, this.#run);
        await openUrl(
          `cursor://anysphere.cursor-deeplink/background-agent?bcId=${encodeURIComponent(threadId)}`,
          this.#run
        );
        this.#remember(threadId, envelope, 'deeplink');
        return { envelope, transport: 'deeplink', nativeId: threadId };
      }
      throw new Error(
        `no public API to inject into Cursor desktop chat ${JSON.stringify(threadId)}. ` +
          `Tried \`${this.#cursorBin} desktop send\` (${desktopErr instanceof Error ? desktopErr.message : String(desktopErr)}). ` +
          'Use a Cloud Agent id (bc-…) with CURSOR_API_KEY, or `agent --resume` for a CLI chat.'
      );
    }
  }

  async #api(path: string, init: RequestInit = {}): Promise<Response> {
    const key = this.#apiKey;
    if (!key) throw new Error('CURSOR_API_KEY is not set');
    const basic = Buffer.from(`${key}:`, 'utf8').toString('base64');
    return this.#fetch(`${this.#apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }
}
