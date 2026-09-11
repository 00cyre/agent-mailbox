export { MailStore, type StoreOptions } from './store.js';
export { createHttpServer, type HttpDeps } from './http.js';
export { createMailboxMcpServer, handleMcpRequest, type McpDeps } from './mcp.js';
export {
  AgentRegistry,
  DEFAULT_CONFIG_PATH,
  DEFAULT_PORT,
  generateToken,
  hashToken,
  initConfig,
  loadConfig,
  type ConfigFile,
  type MailboxConfig,
} from './config.js';
export {
  AGENT_ID,
  MESSAGE_TYPES,
  THREAD_ID,
  publicAgent,
  sendMessage,
  type Agent,
  type Message,
  type MessageType,
  type PublicAgent,
  type SendMessage,
} from './types.js';
export {
  KNOWN_VENDORS,
  VENDOR_ALIASES,
  VENDOR_ID,
  addressText,
  buildReplyEnvelope,
  coerceAddress,
  envelopeSchema,
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
  type VendorAdapter,
} from './adapters/protocol.js';
export { ClaudeAdapter } from './adapters/claude/index.js';
