import type { VendorAdapter } from '../adapter.js';
import type { Envelope } from '../protocol.js';
import type { ReplyBus } from './replies.js';

/**
 * Hub `VendorAdapter` is `send(threadId, envelope)` only. Codex and ChatGPT
 * also expose listen/receive so an out-of-process Mac wrapper can capture the
 * native reply and post it to `reply_to`. In-process hub dispatch does not
 * need listen — that is `GET /v1/inbox`.
 */
export interface ListeningAdapter extends VendorAdapter {
  readonly replies: ReplyBus;
  listen(threadId: string, onReply: (body: string) => void | Promise<void>): () => void;
  send(threadId: string, envelope: Envelope): Promise<void>;
}

export interface AdapterDeps {
  run?: import('./run.js').RunCommand;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  tmpdir?: () => string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}
