import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keeping the hub alive across crashes, logouts and reboots.
 *
 * A mailbox that is only up while a terminal window is open is not a mailbox:
 * the whole promise is that a message sent at 3am is there in the morning. So
 * the hub runs under the platform's own supervisor — launchd on macOS, systemd
 * --user on Linux — and this module is the one place that knows the difference.
 *
 * Everything it writes lives under ~/.agent-mailbox rather than beside the
 * checkout, because the supervisor starts the process with cwd `/` and an
 * `npx`-installed copy lives in a cache directory that npm may delete. A
 * service that points into either is a service that breaks without being
 * touched.
 */

export const LABEL = 'agent-mailbox';
/**
 * Overridable so a second mailbox can be stood up beside a live one — which is
 * also the only way to exercise `service install` without evicting the hub the
 * machine is actually using.
 */
export const HOME = process.env['MAILBOX_HOME'] ?? join(homedir(), '.agent-mailbox');
export const CONFIG = join(HOME, 'mailbox.config.json');
export const DATA = join(HOME, 'data');
export const LOG = join(HOME, 'hub.log');
export const ERR = join(HOME, 'hub.err');

const PLIST = join(homedir(), 'Library', 'LaunchAgents', `com.${LABEL}.plist`);
const UNIT = join(homedir(), '.config', 'systemd', 'user', `${LABEL}.service`);

export type Supervisor = 'launchd' | 'systemd';

export function supervisor(): Supervisor {
  if (platform() === 'darwin') return 'launchd';
  if (platform() === 'linux') return 'systemd';
  throw new Error(
    `no service manager for ${platform()}; run \`agent-mailbox serve\` under your own supervisor`
  );
}

/** The `serve` argv the installed service runs. Reused by `update` so a reinstall keeps its flags. */
export function installedArgs(): string[] {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return [cli, 'serve', '--config', CONFIG];
}

/** `gui/<uid>/com.agent-mailbox` — what the modern launchctl verbs address. */
function domainTarget(): string {
  const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
  return `gui/${uid}/com.${LABEL}`;
}

function run(file: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync(file, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

export function install(): string {
  const kind = supervisor();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (!existsSync(CONFIG)) {
    throw new Error(`no config at ${CONFIG} — run \`agent-mailbox init\` first`);
  }

  const [cli, ...rest] = installedArgs();
  const node = process.execPath;

  if (kind === 'launchd') {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    const argv = [node, cli!, ...rest].map((a) => `    <string>${a}</string>`).join('\n');
    writeFileSync(
      PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.${LABEL}</string>
  <key>ProgramArguments</key><array>
${argv}
  </array>
  <key>WorkingDirectory</key><string>${HOME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${ERR}</string>
</dict></plist>
`,
      'utf8'
    );
    stopLaunchd();
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
    const booted = run('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
    // `bootstrap` is the modern verb; `load` is what older systems have.
    const loaded = booted.ok ? booted : run('launchctl', ['load', PLIST]);
    if (!loaded.ok) throw new Error(`launchctl could not start the job: ${loaded.out}`);
    return PLIST;
  }

  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(
    UNIT,
    `[Unit]
Description=agent-mailbox hub
After=network.target

[Service]
Type=simple
ExecStart=${[node, cli!, ...rest].join(' ')}
WorkingDirectory=${HOME}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
    'utf8'
  );
  run('systemctl', ['--user', 'daemon-reload']);
  const enabled = run('systemctl', ['--user', 'enable', '--now', LABEL]);
  if (!enabled.ok) throw new Error(`systemctl enable failed: ${enabled.out}`);
  return UNIT;
}

/**
 * Stop the job *and* the process.
 *
 * `unload` only deregisters: on a KeepAlive job it can leave the child alive,
 * reparented to init, still holding the port — which then looks like a free
 * port that refuses to bind. `bootout` terminates as well, so it is tried
 * first and `unload` is only the fallback for systems without it.
 */
function stopLaunchd(): void {
  const booted = run('launchctl', ['bootout', domainTarget()]);
  if (!booted.ok) run('launchctl', ['unload', PLIST]);
}

export function uninstall(): string {
  const kind = supervisor();
  if (kind === 'launchd') {
    stopLaunchd();
    rmSync(PLIST, { force: true });
    // Say so rather than leaving a silent orphan behind.
    const still = run('launchctl', ['list']).out.split('\n').some((l) => l.endsWith(`com.${LABEL}`));
    if (still) throw new Error(`removed ${PLIST}, but launchd still lists com.${LABEL}`);
    return PLIST;
  }
  run('systemctl', ['--user', 'disable', '--now', LABEL]);
  rmSync(UNIT, { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  return UNIT;
}

export function status(): string {
  const kind = supervisor();
  if (kind === 'launchd') {
    if (!existsSync(PLIST)) return `not installed (no ${PLIST})`;
    const { out } = run('launchctl', ['list']);
    const line = out.split('\n').find((l) => l.endsWith(`com.${LABEL}`));
    if (!line) return `installed at ${PLIST}, but not loaded`;
    const [pid, code] = line.trim().split(/\s+/u);
    return pid === '-'
      ? `installed, not running (last exit ${code})`
      : `running as pid ${pid}`;
  }
  const { out } = run('systemctl', ['--user', 'status', LABEL, '--no-pager']);
  return out || 'not installed';
}

export function restart(): void {
  const kind = supervisor();
  if (kind === 'launchd') {
    const uid = execFileSync('id', ['-u'], { encoding: 'utf8' }).trim();
    const { ok, out } = run('launchctl', ['kickstart', '-k', `gui/${uid}/com.${LABEL}`]);
    if (!ok) throw new Error(`kickstart failed: ${out}`);
    return;
  }
  const { ok, out } = run('systemctl', ['--user', 'restart', LABEL]);
  if (!ok) throw new Error(`restart failed: ${out}`);
}

/** Where the logs are. Printing a path beats tailing for the caller. */
export function logPaths(): { out: string; err: string } {
  return { out: LOG, err: ERR };
}
