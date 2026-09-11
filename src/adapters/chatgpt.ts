import {
  CHATGPT_CLASSIC_BUNDLE,
  CODEX_BUNDLE,
  chatgptAppUrl,
  chatgptConversationUrl,
  createMacDriver,
  type MacDriver,
} from './mac.js';
import { renderInbound } from './format.js';
import { ReplyBus } from './replies.js';
import { runCommand } from './run.js';
import type { AdapterDeps, ListeningAdapter } from './types.js';
import type { Envelope } from '../protocol.js';

export interface ChatGptAdapterOptions extends AdapterDeps {
  mac?: MacDriver;
  /** POST {threadId, envelope} to a Mac wrapper running elsewhere. */
  wrapperUrl?: string;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * ChatGPT (consumer) vendor adapter.
 *
 * There is no public HTTP API that posts into a specific chatgpt.com
 * conversation. Documented desktop deep links (`codex://threads/<id>`) address
 * Codex threads, not ChatGPT chats. Delivery therefore uses, in order:
 *
 *  1. A local wrapper HTTP endpoint (`wrapperUrl` / `adapt serve`)
 *  2. macOS: open https://chatgpt.com/c/<id> (and the Classic URL scheme),
 *     paste via the clipboard, submit with Accessibility
 *
 * Claude-style in-thread @-mention is not available here.
 */
export class ChatGptAdapter implements ListeningAdapter {
  readonly vendor = 'chatgpt';
  readonly replies = new ReplyBus();
  readonly #mac: MacDriver;
  readonly #wrapperUrl: string | undefined;
  readonly #pollMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fetch: typeof fetch;
  #snapshots = new Map<string, string>();

  constructor(options: ChatGptAdapterOptions = {}) {
    const run = options.run ?? runCommand;
    this.#mac =
      options.mac ??
      createMacDriver({
        run,
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
      });
    this.#wrapperUrl = options.wrapperUrl ?? process.env['MAILBOX_CHATGPT_WRAPPER'];
    this.#pollMs = options.pollMs ?? 2_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async send(threadId: string, envelope: Envelope): Promise<void> {
    const text = renderInbound(envelope);
    if (this.#wrapperUrl) {
      await this.#postWrapper(threadId, envelope);
      return;
    }
    if (this.#mac.platform !== 'darwin') {
      throw new Error(
        `chatgpt adapter cannot inject into ${threadId} on ${this.#mac.platform}. ` +
          `ChatGPT has no public send-to-thread API. Run \`agent-mailbox adapt chatgpt\` ` +
          `on the Mac that has ChatGPT.app, or set MAILBOX_CHATGPT_WRAPPER to that Mac's ` +
          `loopback wrapper. See macos/README.md.`
      );
    }
    await this.#macInject(threadId, text);
  }

  listen(threadId: string, onReply: (body: string) => void | Promise<void>): () => void {
    const stopBus = this.replies.listen(threadId, (body) => {
      void onReply(body);
    });
    if (this.#mac.platform !== 'darwin' || this.#wrapperUrl) {
      return stopBus;
    }
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      void this.#pollVisible(threadId);
    }, this.#pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      stopBus();
    };
  }

  async #postWrapper(threadId: string, envelope: Envelope): Promise<void> {
    const url = `${this.#wrapperUrl!.replace(/\/+$/u, '')}/send`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, envelope }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`chatgpt wrapper ${response.status}: ${detail.slice(0, 400)}`);
    }
    const payload = (await response.json().catch(() => ({}))) as { reply?: string };
    if (typeof payload.reply === 'string' && payload.reply.trim()) {
      this.replies.emit(threadId, payload.reply.trim());
    }
  }

  async #macInject(threadId: string, text: string): Promise<void> {
    await this.#openConversation(threadId);
    await this.#sleep(1_200);
    await this.#mac.copy(text);
    await this.#pasteIntoChat();
    await this.#sleep(400);
    this.#snapshots.set(threadId, await this.#readAny());
  }

  async #openConversation(threadId: string): Promise<void> {
    const https = chatgptConversationUrl(threadId);
    const app = chatgptAppUrl(threadId);
    const attempts: Array<() => Promise<void>> = [
      () => this.#mac.openUrl(app, CHATGPT_CLASSIC_BUNDLE),
      () => this.#mac.openUrl(https, CHATGPT_CLASSIC_BUNDLE),
      () => this.#mac.openUrl(https, CODEX_BUNDLE),
      () => this.#mac.openUrl(https),
    ];
    let last = 'no attempts';
    for (const attempt of attempts) {
      try {
        await attempt();
        return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`could not open ChatGPT conversation ${threadId}: ${last}`);
  }

  async #pasteIntoChat(): Promise<void> {
    const apps = [
      { bundleId: CHATGPT_CLASSIC_BUNDLE, name: 'ChatGPT' },
      { bundleId: CODEX_BUNDLE, name: 'ChatGPT' },
      { bundleId: CODEX_BUNDLE, name: 'Codex' },
    ];
    let last = 'no attempts';
    for (const app of apps) {
      try {
        await this.#mac.pasteAndSubmit(app);
        return;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`could not paste into ChatGPT: ${last}`);
  }

  async #readAny(): Promise<string> {
    const apps = [
      { bundleId: CHATGPT_CLASSIC_BUNDLE, name: 'ChatGPT' },
      { bundleId: CODEX_BUNDLE, name: 'ChatGPT' },
    ];
    for (const app of apps) {
      try {
        return await this.#mac.readVisibleText(app);
      } catch {
        // Try the next bundle. Classic and current desktop can coexist.
      }
    }
    return '';
  }

  async #pollVisible(threadId: string): Promise<string | undefined> {
    const now = await this.#readAny();
    const before = this.#snapshots.get(threadId) ?? '';
    if (!now || now === before) return undefined;
    const delta = diffTail(before, now);
    if (!delta.trim()) return undefined;
    this.#snapshots.set(threadId, now);
    this.replies.emit(threadId, delta.trim());
    return delta.trim();
  }
}

function diffTail(before: string, after: string): string {
  if (after.startsWith(before)) return after.slice(before.length);
  return after;
}
