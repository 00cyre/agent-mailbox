import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as osTmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir as osHomedir } from 'node:os';

import { CODEX_BUNDLE, codexThreadUrl, createMacDriver, type MacDriver } from './mac.js';
import { renderInbound } from './format.js';
import { ReplyBus } from './replies.js';
import { runCommand, type RunCommand } from './run.js';
import type { AdapterDeps, ListeningAdapter } from './types.js';
import type { Envelope } from '../protocol.js';

export interface CodexAdapterOptions extends AdapterDeps {
  bin?: string;
  extraExecArgs?: string[];
  mac?: MacDriver;
  /** Prefer a live-session queue even when exec resume is available. */
  preferQueue?: boolean;
  /** How long listen() pollers wait between session-log checks. */
  pollMs?: number;
  readFile?: (path: string) => string;
  listSessionFiles?: (root: string) => string[];
}

/**
 * Codex vendor adapter.
 *
 * Native paths, in order:
 *  1. `codex queue --thread <id> --message` — live TUI / desktop session (CLI 0.149+)
 *  2. `codex exec resume <id>` — headless follow-up; captures the assistant turn
 *  3. macOS: `codex://threads/<id>` then Accessibility paste (deep link does not send)
 *
 * There is no documented `codex://threads/<id>?prompt=` send. Queue/exec are
 * the public APIs; the Mac wrapper is the fallback Claude-style @-mention
 * does not need.
 */
export class CodexAdapter implements ListeningAdapter {
  readonly vendor = 'codex';
  readonly replies = new ReplyBus();
  readonly #run: RunCommand;
  readonly #bin: string;
  readonly #extraExecArgs: string[];
  readonly #mac: MacDriver;
  readonly #preferQueue: boolean;
  readonly #pollMs: number;
  readonly #homedir: () => string;
  readonly #tmpdir: () => string;
  readonly #readFile: (path: string) => string;
  readonly #listSessionFiles: ((root: string) => string[]) | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    this.#run = options.run ?? runCommand;
    this.#bin = options.bin ?? process.env['CODEX_BIN'] ?? 'codex';
    this.#extraExecArgs = options.extraExecArgs ?? [];
    this.#mac =
      options.mac ??
      createMacDriver({
        run: this.#run,
        ...(options.platform !== undefined ? { platform: options.platform } : {}),
      });
    this.#preferQueue = options.preferQueue ?? true;
    this.#pollMs = options.pollMs ?? 2_000;
    this.#homedir = options.homedir ?? osHomedir;
    this.#tmpdir = options.tmpdir ?? osTmpdir;
    this.#readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
    this.#listSessionFiles = options.listSessionFiles;
  }

  async send(threadId: string, envelope: Envelope): Promise<void> {
    const text = renderInbound(envelope);
    const errors: string[] = [];

    if (this.#preferQueue) {
      const queued = await this.#queue(threadId, text);
      if (queued.ok) return;
      errors.push(queued.error);
    }

    const resumed = await this.#execResume(threadId, text);
    if (resumed.ok) {
      if (resumed.reply.trim()) {
        this.#remember(threadId, resumed.reply.trim());
        this.replies.emit(threadId, resumed.reply.trim());
      }
      return;
    }
    errors.push(resumed.error);

    if (!this.#preferQueue) {
      const queued = await this.#queue(threadId, text);
      if (queued.ok) return;
      errors.push(queued.error);
    }

    if (this.#mac.platform === 'darwin') {
      await this.#macInject(threadId, text);
      return;
    }

    throw new Error(
      `codex adapter could not inject into thread ${threadId}:\n- ${errors.join('\n- ')}\n` +
        `Install Codex CLI (codex queue / codex exec resume) or run this adapter on macOS with Codex.app.`
    );
  }

  listen(threadId: string, onReply: (body: string) => void | Promise<void>): () => void {
    const stopBus = this.replies.listen(threadId, (body) => {
      void onReply(body);
    });
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      this.#pollSessionLog(threadId);
    }, this.#pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
      stopBus();
    };
  }

  async #queue(threadId: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await this.#run(
        [this.#bin, 'queue', '--thread', threadId, '--message', text],
        { timeoutMs: 30_000 }
      );
      if (result.code === 0) return { ok: true };
      return {
        ok: false,
        error: `codex queue: exit ${result.code}: ${summarize(result.stderr || result.stdout)}`,
      };
    } catch (error) {
      return { ok: false, error: `codex queue: ${errorMessage(error)}` };
    }
  }

  async #execResume(
    threadId: string,
    text: string
  ): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
    const dir = mkdtempSync(join(this.#tmpdir(), 'mailbox-codex-'));
    const out = join(dir, 'last-message.txt');
    try {
      writeFileSync(out, '');
      const result = await this.#run(
        [
          this.#bin,
          'exec',
          'resume',
          threadId,
          '--output-last-message',
          out,
          '--json',
          ...this.#extraExecArgs,
          '-',
        ],
        { stdin: text, timeoutMs: 600_000 }
      );
      if (result.code !== 0) {
        return {
          ok: false,
          error: `codex exec resume: exit ${result.code}: ${summarize(result.stderr || result.stdout)}`,
        };
      }
      let reply = '';
      try {
        reply = this.#readFile(out);
      } catch {
        reply = '';
      }
      if (!reply.trim()) reply = lastAssistantFromJsonl(result.stdout);
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, error: `codex exec resume: ${errorMessage(error)}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async #macInject(threadId: string, text: string): Promise<void> {
    await this.#mac.copy(text);
    const url = codexThreadUrl(threadId);
    try {
      await this.#mac.openUrl(url, CODEX_BUNDLE);
    } catch {
      await this.#mac.openUrl(url);
    }
    await this.#mac.pasteAndSubmit({ bundleId: CODEX_BUNDLE, name: 'ChatGPT' });
  }

  #pollSessionLog(threadId: string): string | undefined {
    const files = this.#listSessionFiles?.(join(this.#homedir(), '.codex', 'sessions'));
    if (!files?.length) return undefined;
    const needle = threadId.toLowerCase();
    const match = files.find((path) => path.toLowerCase().includes(needle));
    if (!match) return undefined;
    let contents: string;
    try {
      contents = this.#readFile(match);
    } catch {
      return undefined;
    }
    const reply = lastAssistantFromJsonl(contents);
    if (!reply.trim()) return undefined;
    if (this.#already(threadId, reply.trim())) return undefined;
    this.#remember(threadId, reply.trim());
    this.replies.emit(threadId, reply.trim());
    return reply.trim();
  }

  #seen = new Set<string>();

  #remember(threadId: string, body: string): void {
    this.#seen.add(`${threadId}:${hashish(body)}`);
  }

  #already(threadId: string, body: string): boolean {
    return this.#seen.has(`${threadId}:${hashish(body)}`);
  }
}

function hashish(text: string): string {
  return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
}

function summarize(text: string): string {
  const line = text.trim().split('\n').filter(Boolean).slice(-3).join(' / ');
  return line.slice(0, 400) || '(no output)';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return 'codex binary not found on PATH (set CODEX_BIN)';
    return error.message;
  }
  return String(error);
}

/** Best-effort parse of `codex exec --json` / session JSONL assistant text. */
export function lastAssistantFromJsonl(text: string): string {
  let last = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const extracted = assistantText(event);
      if (extracted) last = extracted;
    } catch {
      // Session logs are JSONL; a partial last line is normal while tailed.
    }
  }
  return last;
}

function assistantText(event: Record<string, unknown>): string | undefined {
  const type = String(event['type'] ?? event['method'] ?? '');
  if (typeof event['finalResponse'] === 'string') return event['finalResponse'];
  if (typeof event['final_response'] === 'string') return event['final_response'];
  const item = event['item'];
  if (item && typeof item === 'object') {
    const rec = item as Record<string, unknown>;
    if (rec['type'] === 'agent_message' && typeof rec['text'] === 'string') return rec['text'];
    if (typeof rec['content'] === 'string') return rec['content'];
  }
  const payload = event['payload'];
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (typeof rec['message'] === 'string' && /agent|assistant/iu.test(type)) return rec['message'];
    if (typeof rec['text'] === 'string' && /agent|assistant/iu.test(String(rec['type'] ?? type))) {
      return rec['text'];
    }
  }
  if (typeof event['text'] === 'string' && /agent_message|assistant/iu.test(type)) {
    return event['text'];
  }
  return undefined;
}
