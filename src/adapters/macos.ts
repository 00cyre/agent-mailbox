import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, type RunCommand } from './process.js';

function macosRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'macos'),
    join(here, '..', '..', '..', 'macos'),
    join(process.cwd(), 'macos'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'cursor-open.applescript'))) return dir;
  }
  return candidates[0]!;
}

function script(name: string): string {
  return readFileSync(join(macosRoot(), name), 'utf8');
}

export function requireDarwin(platform: NodeJS.Platform, what: string): void {
  if (platform !== 'darwin') {
    throw new Error(
      `${what} needs macOS (osascript / URL schemes). This host is ${platform}. ` +
        'Use the public API transport, or run the adapter on the Mac that has the app.'
    );
  }
}

export async function osascript(
  source: string,
  args: string[],
  run: RunCommand,
  timeoutMs = 120_000
): Promise<string> {
  const result = await run('osascript', ['-l', 'AppleScript', '-', ...args], {
    input: source,
    timeoutMs,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `osascript exited ${result.code}`);
  }
  return result.stdout.trim();
}

export async function openUrl(url: string, run: RunCommand): Promise<void> {
  const result = await run('open', [url], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `open failed for ${url}`);
  }
}

function withTempPrompt(text: string, fn: (path: string) => Promise<string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mailbox-adapter-'));
  const file = join(dir, 'prompt.txt');
  writeFileSync(file, text, 'utf8');
  return fn(file).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

export async function cursorOpenCloud(threadId: string, run: RunCommand): Promise<void> {
  const source = script('cursor-open.applescript');
  await osascript(source, [threadId], run, 30_000);
}

export async function cursorDesktopSend(
  threadId: string,
  text: string,
  run: RunCommand,
  bin = 'cursor'
): Promise<string> {
  const result = await run(bin, ['desktop', 'send', threadId], {
    input: text,
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `${bin} desktop send failed`);
  }
  return result.stdout.trim();
}

export async function grokSafariSend(
  threadId: string,
  text: string,
  run: RunCommand,
  timeoutMs = 180_000
): Promise<string> {
  const source = script('grok-safari-send.applescript');
  const inject = join(macosRoot(), 'grok-safari-inject.js');
  const raw = await withTempPrompt(text, (path) =>
    osascript(source, [threadId, path, inject], run, timeoutMs)
  );
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; reply?: string; error?: string };
    if (parsed.ok && parsed.reply) return parsed.reply;
    if (parsed.ok) return '';
    throw new Error(parsed.error ?? raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      if (!raw) throw new Error('grok.com wrapper returned an empty result');
      return raw;
    }
    throw error;
  }
}

export async function grokBotPaste(text: string, run: RunCommand): Promise<void> {
  const source = script('grokbot-paste.applescript');
  await withTempPrompt(text, (path) => osascript(source, [path], run, 30_000));
}
