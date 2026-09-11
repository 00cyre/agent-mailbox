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
  AdapterHub,
  CursorAdapter,
  GrokAdapter,
  createAdapterServer,
  createEnvelope,
  defaultAdapterHub,
  formatAddress,
  parseAddress,
  type Envelope,
} from './adapters/index.js';
