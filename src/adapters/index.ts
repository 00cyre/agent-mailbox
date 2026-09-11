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
  envelopeRefs,
  newEnvelopeId,
  renderInbound,
  replyEnvelope,
  REF_CORRELATION,
  REF_ENVELOPE_ID,
  REF_FROM,
  REF_REPLY_TO,
} from './format.js';
export { ChatGptAdapter, type ChatGptAdapterOptions } from './chatgpt.js';
export { CodexAdapter, lastAssistantFromJsonl, type CodexAdapterOptions } from './codex.js';
export { runBridge, type BridgeOptions } from './bridge.js';
export { HubClient, type HubClientOptions } from './hub.js';
export { createAdapterHttpServer, type AdapterHttpOptions } from './http.js';
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

import type { AdapterRegistry } from '../adapter.js';
import { ChatGptAdapter, type ChatGptAdapterOptions } from './chatgpt.js';
import { CodexAdapter, type CodexAdapterOptions } from './codex.js';
import type { ListeningAdapter } from './types.js';

export function createVendorAdapter(
  vendor: 'codex' | 'chatgpt',
  options: CodexAdapterOptions | ChatGptAdapterOptions = {}
): ListeningAdapter {
  if (vendor === 'codex') return new CodexAdapter(options);
  return new ChatGptAdapter(options);
}

/** Replace hub StubAdapter entries for Codex and ChatGPT. */
export function registerOpenaiAdapters(
  registry: AdapterRegistry,
  options: { codex?: CodexAdapterOptions; chatgpt?: ChatGptAdapterOptions } = {}
): void {
  registry.register(new CodexAdapter(options.codex ?? {}));
  registry.register(new ChatGptAdapter(options.chatgpt ?? {}));
}
