export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export type RunCommand = (argv: string[], options?: RunOptions) => Promise<ExecResult>;

/**
 * Spawn a command. Injected in tests so Codex/ChatGPT adapters never need the
 * real binaries — those live on the user's Mac (or wherever `codex` is).
 */
export async function runCommand(argv: string[], options: RunOptions = {}): Promise<ExecResult> {
  const { spawn } = await import('node:child_process');
  const [bin, ...args] = argv;
  if (!bin) throw new Error('runCommand needs a binary');

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`timed out after ${options.timeoutMs}ms: ${argv.join(' ')}`));
          }, options.timeoutMs)
        : undefined;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
