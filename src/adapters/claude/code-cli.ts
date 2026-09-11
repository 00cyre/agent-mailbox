import { spawn } from 'node:child_process';
import type { Envelope, SendResult } from '../protocol.js';
import { formatCliPrompt } from './format.js';

export interface CliRunnerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (
  argv: string[],
  options: { cwd?: string; stdin?: string }
) => Promise<CliRunnerResult>;

export interface CodeCliOptions {
  bin?: string;
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  run?: CliRunner;
  which?: (bin: string) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export function defaultCliRunner(
  bin: string,
  timeoutMs: number
): CliRunner {
  return (argv, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, argv, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      if (options.stdin) child.stdin.write(options.stdin);
      child.stdin.end();
    });
}

async function defaultWhich(bin: string): Promise<boolean> {
  try {
    const result = await defaultCliRunner('sh', 5_000)(['-c', `command -v ${shellSingle(bin)}`], {});
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function shellSingle(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Native send+receive for a Claude Code session.
 *
 * Documented: `claude -p --resume <session-id> --output-format json "…"`.
 * Session lookup is scoped to `cwd` (the project that owns the transcript).
 */
export class CodeCliTransport {
  readonly #bin: string;
  readonly #cwd: string | undefined;
  readonly #extraArgs: string[];
  readonly #run: CliRunner;
  readonly #which: (bin: string) => Promise<boolean>;

  constructor(options: CodeCliOptions = {}) {
    this.#bin = options.bin ?? process.env['MAILBOX_CLAUDE_BIN'] ?? 'claude';
    this.#cwd = options.cwd ?? process.env['MAILBOX_CLAUDE_CWD'];
    this.#extraArgs = options.extraArgs ?? [];
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#run = options.run ?? defaultCliRunner(this.#bin, timeout);
    this.#which = options.which ?? defaultWhich;
  }

  async available(): Promise<boolean> {
    return this.#which(this.#bin);
  }

  async send(threadId: string, envelope: Envelope): Promise<SendResult> {
    const prompt = formatCliPrompt(envelope);
    const argv = [
      '-p',
      '--resume',
      threadId,
      '--output-format',
      'json',
      ...this.#extraArgs,
      prompt,
    ];
    const result = await this.#run(argv, this.#cwd !== undefined ? { cwd: this.#cwd } : {});
    if (result.code !== 0) {
      throw new Error(
        `claude CLI exited ${result.code} resuming ${threadId}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`
      );
    }
    const replyBody = extractCliResult(result.stdout);
    const out: SendResult = { transport: 'code-cli', delivered: true };
    if (replyBody !== undefined) out.replyBody = replyBody;
    return out;
  }
}

export function extractCliResult(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown };
    if (typeof parsed.result === 'string' && parsed.result.length > 0) return parsed.result;
  } catch {
    // Headless sometimes prints a log line before the JSON object.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { result?: unknown };
        if (typeof parsed.result === 'string' && parsed.result.length > 0) return parsed.result;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return trimmed;
}
