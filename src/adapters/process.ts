import { spawn } from 'node:child_process';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : undefined;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });

export async function which(bin: string, run: RunCommand = runCommand): Promise<boolean> {
  const result = await run('sh', ['-c', `command -v ${JSON.stringify(bin)} >/dev/null 2>&1`]);
  return result.code === 0;
}
