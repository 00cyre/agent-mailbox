import type { AdapterRegistry } from '../adapter.js';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './claude/adapter.js';
import { CursorAdapter, type CursorAdapterOptions } from './cursor.js';
import { GrokAdapter, type GrokAdapterOptions } from './grok.js';
import { ChatGptAdapter, type ChatGptAdapterOptions } from './chatgpt.js';
import { CodexAdapter, type CodexAdapterOptions } from './codex.js';
import type { ListeningAdapter } from './types.js';

export {
  AdapterRegistry,
  StubAdapter,
  type Delivery,
  type VendorAdapter,
} from '../adapter.js';
export {
  KNOWN_VENDORS,
  VENDOR_ALIASES,
  VENDOR_ID,
  formatAddress,
  formatReplyDestination,
  inferVendor,
  isAddress,
  parseAddress,
  replyDestination,
  toEnvelope,
  type Address,
  type Envelope,
  type KnownVendor,
  type Vendor,
} from '../protocol.js';
export {
  addr,
  coerceEnvelope,
  correlationSlug,
  envelopeFromHubMessage,
  envelopeFromMailbox,
  envelopeRefs,
  formatForThread,
  mailboxTarget,
  newEnvelopeId,
  parseFormatted,
  refsWithReplyTo,
  renderInbound,
  replyEnvelope,
  replyToFromRefs,
  REF_CORRELATION,
  REF_ENVELOPE_ID,
  REF_FROM,
  REF_REPLY_TO,
} from './format.js';
export { ChatGptAdapter, type ChatGptAdapterOptions } from './chatgpt.js';
export { CodexAdapter, lastAssistantFromJsonl, type CodexAdapterOptions } from './codex.js';
export { CursorAdapter, isCursorCloudId, type CursorAdapterOptions } from './cursor.js';
export { GrokAdapter, extractXaiText, isGrokWebId, isXaiResponseId, type GrokAdapterOptions } from './grok.js';
export { ClaudeAdapter, type ClaudeAdapterOptions } from './claude/adapter.js';
export { runBridge, type BridgeOptions } from './bridge.js';
export { HubClient, type HubClientOptions } from './hub.js';
export { createAdapterHttpServer, type AdapterHttpOptions } from './http.js';
export { createAdapterServer } from './server.js';
export { AdapterHub, defaultAdapterHub, envelopeFromSendBody } from './dispatch.js';
export { createMailboxClient, runMailboxBridge, type MailboxClient } from './mailbox-bridge.js';
export { createEnvelope } from './protocol.js';
export {
  CHATGPT_CLASSIC_BUNDLE,
  CODEX_BUNDLE,
  MAC_SETUP,
  chatgptAppUrl,
  chatgptConversationUrl,
  codexThreadUrl,
  createMacDriver,
  type MacApp,
  type MacDriver,
} from './mac.js';
export { ReplyBus } from './replies.js';
export { runCommand, type ExecResult, type RunCommand, type RunOptions } from './run.js';
export type { AdapterDeps, ListeningAdapter } from './types.js';

export function createVendorAdapter(
  vendor: 'codex' | 'chatgpt',
  options: CodexAdapterOptions | ChatGptAdapterOptions = {}
): ListeningAdapter {
  if (vendor === 'codex') return new CodexAdapter(options as CodexAdapterOptions);
  return new ChatGptAdapter(options as ChatGptAdapterOptions);
}

/** Replace hub StubAdapter entries for Codex and ChatGPT. */
export function registerOpenaiAdapters(
  registry: AdapterRegistry,
  options: { codex?: CodexAdapterOptions; chatgpt?: ChatGptAdapterOptions } = {}
): void {
  registry.register(new CodexAdapter(options.codex ?? {}));
  registry.register(new ChatGptAdapter(options.chatgpt ?? {}));
}

export function registerCursorGrokAdapters(
  registry: AdapterRegistry,
  options: { cursor?: CursorAdapterOptions; grok?: GrokAdapterOptions } = {}
): void {
  registry.register(new CursorAdapter(options.cursor ?? {}));
  registry.register(new GrokAdapter(options.grok ?? {}));
}

export function registerClaudeAdapter(
  registry: AdapterRegistry,
  options: ClaudeAdapterOptions = {}
): void {
  registry.register(new ClaudeAdapter(options));
}

/** All five vendors: Claude, Cursor, Grok, Codex, ChatGPT. */
export function registerVendorAdapters(
  registry: AdapterRegistry,
  options: {
    claude?: ClaudeAdapterOptions;
    cursor?: CursorAdapterOptions;
    grok?: GrokAdapterOptions;
    codex?: CodexAdapterOptions;
    chatgpt?: ChatGptAdapterOptions;
  } = {}
): void {
  registerClaudeAdapter(registry, options.claude ?? {});
  registerCursorGrokAdapters(registry, {
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.grok !== undefined ? { grok: options.grok } : {}),
  });
  registerOpenaiAdapters(registry, {
    ...(options.codex !== undefined ? { codex: options.codex } : {}),
    ...(options.chatgpt !== undefined ? { chatgpt: options.chatgpt } : {}),
  });
}
