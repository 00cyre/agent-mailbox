import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Envelope, SendResult } from '../protocol.js';
import { desktopChatUrl, desktopPrefillQuery } from './format.js';

export type OpenUrl = (url: string) => Promise<void>;
export type RunScript = (script: string) => Promise<void>;
export type CopyText = (text: string) => Promise<void>;

export type SubmitKey = 'command-return' | 'return';

export interface DesktopOptions {
  openUrl?: OpenUrl;
  runScript?: RunScript;
  copyText?: CopyText;
  submitKey?: SubmitKey;
  /** Open the thread but do not keystroke-send. Default true on non-darwin. */
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  delayMs?: number;
}

/**
 * AppleScript that pastes the clipboard into Claude Desktop and submits.
 *
 * Claude has no public "send to this chat" API. The documented `claude://`
 * URL opens the thread (and `q=` prefills a *new* chat). After the PromptFiction
 * fix, links no longer auto-submit — so putting the message on the clipboard
 * and sending Cmd+Return is the same motion as pasting an @-mention into the
 * composer. Accessibility must be granted to the process that runs osascript
 * (see MAC.md).
 */
export function pasteAndSubmitScript(submitKey: SubmitKey, delaySec: number): string {
  const keystroke =
    submitKey === 'return'
      ? 'keystroke return'
      : 'keystroke return using command down';
  return `
tell application "Claude" to activate
delay ${delaySec}
tell application "System Events"
  if exists process "Claude" then
    tell process "Claude" to set frontmost to true
  else if exists process "Claude Desktop" then
    tell process "Claude Desktop" to set frontmost to true
  end if
  delay 0.2
  keystroke "a" using command down
  delay 0.05
  keystroke "v" using command down
  delay 0.2
  ${keystroke}
end tell
`.trim();
}

export function defaultOpenUrl(platform: NodeJS.Platform): OpenUrl {
  return async (url: string) => {
    const result = await runCommand(openProgram(platform), openArgs(platform, url));
    if (result.code !== 0) {
      throw new Error(`failed to open ${url}: ${result.stderr || result.stdout}`);
    }
  };
}

function openProgram(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'cmd';
  return 'xdg-open';
}

function openArgs(platform: NodeJS.Platform, url: string): string[] {
  if (platform === 'win32') return ['/c', 'start', '', url];
  return [url];
}

export function defaultCopyText(platform: NodeJS.Platform): CopyText {
  return async (text: string) => {
    if (platform !== 'darwin') {
      throw new Error('clipboard paste needs pbcopy on macOS');
    }
    const result = await runCommand('pbcopy', [], text);
    if (result.code !== 0) throw new Error(`pbcopy failed: ${result.stderr}`);
  };
}

export function defaultRunScript(): RunScript {
  return async (script: string) => {
    const file = join(tmpdir(), `mailbox-claude-${randomBytes(6).toString('hex')}.scpt`);
    writeFileSync(file, script, 'utf8');
    try {
      const result = await runCommand('osascript', [file]);
      if (result.code !== 0) {
        throw new Error(`osascript failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
    } finally {
      try {
        unlinkSync(file);
      } catch {
        // temp file; ignoring a leftover is fine
      }
    }
  };
}

function runCommand(command: string, args: string[], stdin?: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    );
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export class DesktopTransport {
  readonly #openUrl: OpenUrl;
  readonly #runScript: RunScript | undefined;
  readonly #copyText: CopyText | undefined;
  readonly #submitKey: SubmitKey;
  readonly #dryRun: boolean;
  readonly #platform: NodeJS.Platform;
  readonly #delayMs: number;

  constructor(options: DesktopOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#dryRun = options.dryRun ?? this.#platform !== 'darwin';
    this.#submitKey = options.submitKey ?? 'command-return';
    this.#delayMs = options.delayMs ?? 800;
    this.#openUrl = options.openUrl ?? (this.#dryRun ? async () => undefined : defaultOpenUrl(this.#platform));
    this.#runScript = options.runScript ?? (this.#dryRun ? undefined : defaultRunScript());
    this.#copyText = options.copyText ?? (this.#dryRun ? undefined : defaultCopyText(this.#platform));
  }

  async send(threadId: string, envelope: Envelope): Promise<SendResult> {
    const q = desktopPrefillQuery(envelope);
    const url = desktopChatUrl(threadId, q);
    await this.#openUrl(url);

    if (this.#dryRun) {
      return { transport: 'desktop', delivered: true };
    }

    if (this.#platform !== 'darwin') {
      throw new Error(
        `Claude Desktop send needs macOS (open + osascript). This host is ${this.#platform}. ` +
          `Opened ${url} as a focus-only fallback. See src/adapters/claude/MAC.md`
      );
    }

    const prompt = q ?? envelope.body;
    if (this.#copyText) await this.#copyText(prompt);
    if (this.#runScript) {
      await this.#runScript(pasteAndSubmitScript(this.#submitKey, this.#delayMs / 1000));
    }
    return { transport: 'desktop', delivered: true };
  }
}
