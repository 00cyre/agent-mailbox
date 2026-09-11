import { formatAddress, type Address, type Envelope } from '../protocol.js';
import { addr, replyEnvelope } from './format.js';
import type { ListeningAdapter } from './types.js';
import { HubClient } from './hub.js';

export interface BridgeOptions {
  hub: HubClient;
  adapter: ListeningAdapter;
  threadId: string;
  /** How long to wait for the native thread to produce a reply. */
  replyTimeoutMs?: number;
  waitMs?: number;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stop after this many inbound hub messages (tests). */
  maxInbound?: number;
  shouldContinue?: () => boolean;
  /** Override inbox cursor. Default is hub head (skip backlog). */
  startCursor?: number;
}

/**
 * Claim `{vendor}:{threadId}` on the hub, inject each inbound envelope into
 * that native thread, and post the native reply to `reply_to`.
 *
 * In-process, the hub calls `adapter.send` itself (PR for n-to-n routing).
 * This loop is the out-of-process Mac/CLI wrapper: long-poll inbox, inject,
 * return.
 */
export async function runBridge(options: BridgeOptions): Promise<void> {
  const { hub, adapter, threadId } = options;
  const self: Address = addr(adapter.vendor, threadId);
  const address = formatAddress(self);
  const replyTimeout = options.replyTimeoutMs ?? 600_000;
  const waitMs = options.waitMs ?? 120_000;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const chat = await hub.register(address);
  log(`listening as ${address} (hub slug ${chat.slug})`);

  let current: Envelope | undefined;
  const stop = adapter.listen(threadId, async (body) => {
    const inbound = current;
    current = undefined;
    if (!inbound) {
      log(`native output on ${address} with no pending inbound; ignoring`);
      return;
    }
    const outbound = replyEnvelope(inbound, body, self);
    try {
      const sent = await hub.sendEnvelope(outbound, { type: 'reply', in_reply_to: inbound.id });
      log(`replied ${sent.id} to ${formatAddress(outbound.to)}`);
    } catch (error) {
      log(`failed to return reply to ${formatAddress(inbound.reply_to ?? inbound.from)}: ${errorMessage(error)}`);
    }
  });

  const who = await hub.whoami();
  let cursor = options.startCursor ?? who.head;
  let seen = 0;

  try {
    while (options.shouldContinue?.() ?? true) {
      if (options.maxInbound !== undefined && seen >= options.maxInbound) break;
      let batch: { data: import('../types.js').Message[]; cursor: number };
      try {
        batch = await hub.inbox(cursor, waitMs, chat.slug);
      } catch (error) {
        log(`poll: ${errorMessage(error)}`);
        await sleep(3_000);
        continue;
      }
      cursor = batch.cursor;
      for (const message of batch.data) {
        const inbound = hub.inboundEnvelope(message, self);
        current = inbound;
        seen += 1;
        log(`inbound ${inbound.id} from ${formatAddress(inbound.from)} → injecting into ${address}`);
        try {
          await adapter.send(threadId, inbound);
        } catch (error) {
          current = undefined;
          log(`inject failed: ${errorMessage(error)}`);
          continue;
        }
        const pending = inbound;
        setTimeout(() => {
          if (current === pending) {
            current = undefined;
            log(`no native reply within ${replyTimeout}ms for ${inbound.id}`);
          }
        }, replyTimeout).unref();
        if (options.maxInbound !== undefined && seen >= options.maxInbound) break;
      }
    }
  } finally {
    stop();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
