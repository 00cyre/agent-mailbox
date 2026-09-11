export { ClaudeAdapter, type ClaudeAdapterOptions, type ClaudeTransportName } from './adapter.js';
export { CodeCliTransport, extractCliResult, type CodeCliOptions } from './code-cli.js';
export {
  DesktopTransport,
  pasteAndSubmitScript,
  type DesktopOptions,
  type SubmitKey,
} from './desktop.js';
export {
  CHANNEL_INSTRUCTIONS,
  channelMeta,
  desktopChatUrl,
  desktopChatUrl as chatDeepLink,
  desktopPrefillQuery,
  formatChannelContent,
  formatCliPrompt,
  formatListenBlock,
  looksLikeUuid,
  normalizeClaudeThreadId,
} from './format.js';
export {
  mailboxMessageToEnvelope,
  envelopeToSendMessage,
  envelopeToLegacySendMessage,
  parseEnvelope,
} from './envelope.js';
export {
  ChannelRegistry,
  ChannelTransport,
  channelPayload,
  defaultStatePath,
  registerListener,
  lookupListener,
} from './channel-registry.js';
export { createClaudeChannelMcp, serveClaudeChannel, replyEnvelopeFromTool } from './channel.js';
export { HubClient, bridgeLoop, threadIdFromMessage } from './bridge.js';
export { createClaudeSidecar } from './sidecar.js';
