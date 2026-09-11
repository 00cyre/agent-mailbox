import { runCommand, type RunCommand } from './run.js';

export const CHATGPT_CLASSIC_BUNDLE = 'com.openai.chat';
export const CODEX_BUNDLE = 'com.openai.codex';

/** ChatGPT consumer conversation in the desktop app or browser. */
export function chatgptConversationUrl(threadId: string): string {
  return `https://chatgpt.com/c/${encodeURIComponent(threadId)}`;
}

/**
 * Community/iOS shortcut form. Classic ChatGPT.app (`com.openai.chat`) has
 * been observed opening `com.openai.chat://chatgpt.com/c/{id}`. The current
 * ChatGPT desktop build (bundle `com.openai.codex`) documents `codex://`
 * for Codex threads, not ChatGPT conversations — so this is a best-effort
 * extra, not the primary address.
 */
export function chatgptAppUrl(threadId: string): string {
  return `com.openai.chat://chatgpt.com/c/${encodeURIComponent(threadId)}`;
}

/** Official Codex desktop deep link. Opens that thread; does not send. */
export function codexThreadUrl(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export interface MacApp {
  /** LaunchServices bundle id, when known. */
  bundleId: string;
  /** Process/app name for System Events (`ChatGPT`, `Codex`). */
  name: string;
}

export interface MacDriver {
  platform: NodeJS.Platform;
  openUrl(url: string, bundleId?: string): Promise<void>;
  copy(text: string): Promise<void>;
  pasteAndSubmit(app: MacApp): Promise<void>;
  readVisibleText(app: MacApp): Promise<string>;
}

const PASTE_JXA = `
function run(argv) {
  var bundleId = argv[0];
  var name = argv[1] || '';
  var se = Application('System Events');
  se.includeStandardAdditions = true;
  var app;
  try {
    app = Application(bundleId);
  } catch (e) {
    app = name ? Application(name) : null;
  }
  if (app) app.activate();
  delay(0.8);
  se.keystroke('v', { using: 'command down' });
  delay(0.25);
  se.keystroke('\\r');
}
`;

const READ_JXA = `
function run(argv) {
  var bundleId = argv[0];
  var name = argv[1] || '';
  var se = Application('System Events');
  var procs = se.processes.whose({ bundleIdentifier: bundleId });
  if (!procs.length && name) procs = se.processes.whose({ name: name });
  if (!procs.length) return '';
  var win = procs[0].windows[0];
  if (!win) return '';
  try {
    return win.entireContents().toString();
  } catch (e) {
    try {
      return String(win.name());
    } catch (e2) {
      return '';
    }
  }
}
`;

export function createMacDriver(options: {
  run?: RunCommand;
  platform?: NodeJS.Platform;
} = {}): MacDriver {
  const run = options.run ?? runCommand;
  const platform = options.platform ?? process.platform;

  async function osascript(script: string, args: string[]): Promise<string> {
    const result = await run(['osascript', '-l', 'JavaScript', '-e', script, ...args], {
      timeoutMs: 30_000,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `osascript exited ${result.code}`);
    }
    return result.stdout;
  }

  return {
    platform,
    async openUrl(url: string, bundleId?: string): Promise<void> {
      if (platform !== 'darwin') {
        throw new Error(`openUrl is macOS-only (need to open ${url})`);
      }
      const argv = bundleId ? ['open', '-b', bundleId, url] : ['open', url];
      const result = await run(argv, { timeoutMs: 15_000 });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `open exited ${result.code} for ${url}`);
      }
    },
    async copy(text: string): Promise<void> {
      if (platform !== 'darwin') throw new Error('pbcopy is macOS-only');
      const result = await run(['pbcopy'], { stdin: text, timeoutMs: 10_000 });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `pbcopy exited ${result.code}`);
      }
    },
    async pasteAndSubmit(app: MacApp): Promise<void> {
      if (platform !== 'darwin') throw new Error('AppleScript inject is macOS-only');
      await osascript(PASTE_JXA, [app.bundleId, app.name]);
    },
    async readVisibleText(app: MacApp): Promise<string> {
      if (platform !== 'darwin') throw new Error('Accessibility read is macOS-only');
      return osascript(READ_JXA, [app.bundleId, app.name]);
    },
  };
}

export const MAC_SETUP = `
Mac setup (ChatGPT / Codex desktop)

ChatGPT and Codex Mac apps have no public send-to-thread API comparable to
Claude's native @-mention. This adapter opens the thread, pastes, and submits
via Accessibility.

1. Install ChatGPT for Mac from https://openai.com/chatgpt/desktop/
   Classic ChatGPT.app is bundle com.openai.chat.
   Current ChatGPT desktop (Codex lineage) is bundle com.openai.codex
   and may still be named ChatGPT.app or Codex.app.

2. System Settings → Privacy & Security → Accessibility
   Enable the terminal (or launchd job) that runs \`agent-mailbox adapt\`.
   Paste-and-submit uses System Events keystrokes.

3. Copy the thread id while the target chat is focused:
   ChatGPT conversation: the UUID in https://chatgpt.com/c/<id>
     or ChatGPT → Copy chat deep link (⌘⌥L).
   Codex thread: Copy session ID (⌘⌥C), or the UUID in
     codex://threads/<id>

4. Grant Automation permission if macOS prompts for System Events / ChatGPT.

5. Run the adapter on this Mac (the hub can stay on loopback):

   MAILBOX_TOKEN=… agent-mailbox adapt chatgpt --thread <conversation-id>
   MAILBOX_TOKEN=… agent-mailbox adapt codex --thread <session-uuid>

Codex CLI (Linux or Mac) is preferred over the desktop wrapper when \`codex\`
is installed: \`codex queue --thread <id> --message …\` for a live session,
\`codex exec resume <id>\` for a headless turn that returns the reply.
`.trim();
