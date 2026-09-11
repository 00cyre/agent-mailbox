export { MailStore, type StoreOptions } from './store.js';
export { createHttpServer, type HttpDeps } from './http.js';
export { createMailboxMcpServer, handleMcpRequest, type McpDeps } from './mcp.js';
export { MailboxHub, HubError, type HubOptions } from './hub.js';
export {
  AdapterRegistry,
  StubAdapter,
  type Delivery,
  type VendorAdapter,
} from './adapter.js';
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
} from './protocol.js';
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
  inboxNames,
  publicAgent,
  sendMessage,
  type Agent,
  type Message,
  type MessageType,
  type PublicAgent,
  type SendMessage,
} from './types.js';
export {
  registerClaudeAdapter,
  registerCursorGrokAdapters,
  registerOpenaiAdapters,
  registerVendorAdapters,
  ClaudeAdapter,
  CursorAdapter,
  GrokAdapter,
  CodexAdapter,
  ChatGptAdapter,
} from './adapters/index.js';
