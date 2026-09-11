export {
  VENDORS,
  createEnvelope,
  formatAddress,
  isVendor,
  mintId,
  parseAddress,
  replyEnvelope,
  type Address,
  type Envelope,
  type ReceiveResult,
  type SendResult,
  type Vendor,
  type VendorAdapter,
} from './protocol.js';
export { formatForThread, parseFormatted, refsWithReplyTo, replyToFromRefs } from './format.js';
export { CursorAdapter, isCursorCloudId } from './cursor.js';
export { GrokAdapter, extractXaiText, isGrokWebId, isXaiResponseId } from './grok.js';
export { AdapterHub, defaultAdapterHub, envelopeFromSendBody } from './hub.js';
export { createAdapterServer } from './server.js';
export {
  createMailboxClient,
  envelopeFromMailbox,
  mailboxTarget,
  runMailboxBridge,
} from './bridge.js';
