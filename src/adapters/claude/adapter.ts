import type { Envelope, SendResult, VendorAdapter } from '../protocol.js';
import { ChannelRegistry, ChannelTransport } from './channel-registry.js';
import { CodeCliTransport, type CodeCliOptions } from './code-cli.js';
import { DesktopTransport, type DesktopOptions } from './desktop.js';
import { formatListenBlock, looksLikeUuid, normalizeClaudeThreadId } from './format.js';

export type ClaudeTransportName = 'channel' | 'code-cli' | 'desktop' | 'listen';

export interface ClaudeAdapterOptions {
  /** Order to try. Default: channel, code-cli, desktop, listen. */
  transports?: ClaudeTransportName[];
  codeCli?: CodeCliTransport | CodeCliOptions;
  desktop?: DesktopTransport | DesktopOptions;
  channel?: ChannelTransport;
  listenWriter?: (threadId: string, envelope: Envelope) => Promise<void> | void;
  /** When true, a missing transport is an error instead of falling through. */
  strict?: boolean;
}

const DEFAULT_TRANSPORTS: ClaudeTransportName[] = ['channel', 'code-cli', 'desktop', 'listen'];

function defaultListenWriter(_threadId: string, envelope: Envelope): void {
  process.stdout.write(formatListenBlock(envelope));
}

/**
 * Claude vendor adapter.
 *
 * `send(threadId, envelope)` drops a mailbox envelope into Claude thread Y
 * so a message from e.g. `grok:X` can land there, and a reply (via the
 * channel `reply` tool or `claude -p` stdout) can go back to X with the
 * same `reply_to` / `correlation_id`.
 *
 * Transports, in order:
 * 1. **channel** — Claude Code's documented `notifications/claude/channel`
 *    injection (the same mechanism as @-mentions / Telegram / iMessage).
 * 2. **code-cli** — `claude -p --resume <id>` (documented headless send+receive).
 * 3. **desktop** — `claude://claude.ai/chat/{id}` (documented URL scheme) plus
 *    a Mac paste-and-submit wrapper, because links no longer auto-send.
 * 4. **listen** — the existing Monitor stdout block, so today's unilateral
 *    path still works.
 */
export class ClaudeAdapter implements VendorAdapter {
  readonly vendor = 'claude' as const;
  readonly #transports: ClaudeTransportName[];
  readonly #codeCli: CodeCliTransport;
  readonly #desktop: DesktopTransport;
  readonly #channel: ChannelTransport;
  readonly #listenWriter: (threadId: string, envelope: Envelope) => Promise<void> | void;
  readonly #strict: boolean;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#transports = options.transports ?? DEFAULT_TRANSPORTS;
    this.#codeCli =
      options.codeCli instanceof CodeCliTransport
        ? options.codeCli
        : new CodeCliTransport(options.codeCli);
    this.#desktop =
      options.desktop instanceof DesktopTransport
        ? options.desktop
        : new DesktopTransport(options.desktop);
    this.#channel = options.channel ?? new ChannelTransport();
    this.#listenWriter = options.listenWriter ?? defaultListenWriter;
    this.#strict = options.strict === true;
  }

  get channels(): ChannelRegistry {
    return this.#channel.registry;
  }

  async send(threadId: string, envelope: Envelope): Promise<void> {
    await this.deliver(threadId, envelope);
  }

  /** Same as `send`, but reports which transport fired and any captured CLI reply. */
  async deliver(threadId: string, envelope: Envelope): Promise<SendResult> {
    const id = normalizeClaudeThreadId(threadId);
    const errors: string[] = [];

    for (const name of this.#transports) {
      try {
        const result = await this.#try(name, id, envelope);
        if (result) return result;
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        if (this.#strict) throw error;
      }
    }

    throw new Error(
      `no Claude transport delivered claude:${id}` +
        (errors.length > 0 ? ` (${errors.join('; ')})` : '')
    );
  }

  async #try(
    name: ClaudeTransportName,
    threadId: string,
    envelope: Envelope
  ): Promise<SendResult | undefined> {
    switch (name) {
      case 'channel':
        return this.#channel.send(threadId, envelope);
      case 'code-cli': {
        if (!(await this.#codeCli.available())) return undefined;
        return this.#codeCli.send(threadId, envelope);
      }
      case 'desktop': {
        // UUIDs are claude.ai / Desktop conversation ids *or* Code session ids.
        // Channel and CLI already had a chance; Desktop is the remaining native focus.
        if (!looksLikeUuid(threadId) && threadId !== 'new') return undefined;
        return this.#desktop.send(threadId, envelope);
      }
      case 'listen':
        await this.#listenWriter(threadId, envelope);
        return { transport: 'listen', delivered: true };
    }
  }
}
