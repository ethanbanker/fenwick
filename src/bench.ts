import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Config } from './config.ts';
import { envValue, notifyDiscord, panelUrl } from './notify.ts';

/** With the bot in the channel it posts buttons; the webhook is the fallback. */
function botHandlesAsks(): boolean {
  return Boolean(envValue('DISCORD_BOT_TOKEN') && envValue('DISCORD_CHANNEL_ID'));
}

/**
 * The bench.
 *
 * He cannot run arbitrary commands. He can only ask for one, and it sits in
 * data/bench.json until the owner approves it in /admin. An approved command
 * runs without a shell escape route, in a fresh network namespace, as an
 * unprivileged user, with the workshop as its home and working directory and no
 * API keys anywhere in its environment.
 */

export type BenchState = 'pending' | 'running' | 'done' | 'failed' | 'denied';

export type BenchRequest = {
  id: string;
  command: string;
  note: string;
  day: number;
  at: number;
  status: BenchState;
  output?: string;
  exitCode?: number | null;
  decidedAt?: number;
  finishedAt?: number;
  /** the brain has read the outcome back */
  delivered?: boolean;
  /** the webhook took it, so a restart does not send it twice */
  notified?: boolean;
};

type BenchFile = { requests: BenchRequest[] };
type Identity = { uid: number; gid: number };

const CAP = 60;
const PENDING_CAP = 6;

function fileFor(cfg: Config): string {
  return path.join(cfg.dataDir, 'bench.json');
}

export function benchDir(cfg: Config): string {
  const dir = path.join(cfg.dataDir, 'workshop');
  fs.mkdirSync(dir, { recursive: true });
  // a directory created by root would lock the sandbox user out of its own home
  chownToBench(cfg, dir);
  return dir;
}

function load(cfg: Config): BenchFile {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(cfg), 'utf8')) as BenchFile;
    if (Array.isArray(raw?.requests)) {
      return { requests: raw.requests.filter((r) => r && typeof r.command === 'string' && typeof r.id === 'string') };
    }
  } catch {
    /* first run */
  }
  return { requests: [] };
}

function save(cfg: Config, data: BenchFile): void {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = fileFor(cfg);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Read uid/gid straight from /etc/passwd; containers often have no useradd. */
function lookup(user: string): Identity | null {
  try {
    const line = fs
      .readFileSync('/etc/passwd', 'utf8')
      .split('\n')
      .find((l) => l.split(':')[0] === user);
    if (!line) return null;
    const parts = line.split(':');
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 1) return null;
    return { uid, gid };
  } catch {
    return null;
  }
}

export function benchIdentity(cfg: Config): Identity | null {
  return lookup(cfg.bench.user);
}

/** If we have no unshare, we still drop privileges, we just cannot cut the network. */
function haveUnshare(): boolean {
  return ['/usr/bin/unshare', '/bin/unshare'].some((p) => fs.existsSync(p));
}

/** Files he writes must stay writable by the sandbox user, not just by root. */
export function chownToBench(cfg: Config, target: string): void {
  const who = lookup(cfg.bench.user);
  if (!who) return;
  try {
    fs.chownSync(target, who.uid, who.gid);
  } catch {
    /* not fatal: he just cannot rewrite it */
  }
}

export function submit(
  cfg: Config,
  command: string,
  note: string,
  day: number,
): { ok: boolean; id?: string; reason?: string } {
  if (!cfg.bench.enabled) return { ok: false, reason: 'the bench is closed' };
  const cmd = String(command ?? '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, 600);
  if (cmd.length < 2) return { ok: false, reason: 'no command given' };

  const data = load(cfg);
  const waiting = data.requests.filter((r) => r.status === 'pending').length;
  if (waiting >= PENDING_CAP) {
    return { ok: false, reason: `${waiting} requests are already waiting for the owner; wait for an answer` };
  }

  const req: BenchRequest = {
    id: Math.random().toString(36).slice(2, 8),
    command: cmd,
    note: String(note ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    day,
    at: Date.now(),
    status: 'pending',
  };
  data.requests.push(req);
  if (data.requests.length > CAP) {
    // never drop something still waiting on an answer
    const live = data.requests.filter((r) => r.status === 'pending' || r.status === 'running');
    const done = data.requests.filter((r) => r.status !== 'pending' && r.status !== 'running').slice(-(CAP - live.length));
    data.requests = [...done, ...live].sort((a, b) => a.at - b.at);
  }
  save(cfg, data);

  // Tell the owner, if a webhook is configured. Fire and forget: a dead webhook
  // must not stop the request from being queued. The bot posts its own message
  // with buttons, so the webhook would only be a duplicate when it is running.
  const link = panelUrl();
  if (!botHandlesAsks()) void notifyDiscord(
    `**${cfg.creature.name} is asking to run a command**\n\`\`\`\n${cmd.slice(0, 400)}\n\`\`\`\n` +
      (req.note ? `he says: ${req.note}\n` : '') +
      (link ? `approve or refuse: ${link}` : 'approve or refuse in the admin panel, bench section'),
  ).then((sent) => {
    if (!sent) return;
    const again = load(cfg);
    const target = again.requests.find((r) => r.id === req.id);
    if (target) {
      target.notified = true;
      save(cfg, again);
    }
  });

  return { ok: true, id: req.id };
}

export function decide(cfg: Config, id: string, approve: boolean): { ok: boolean; error?: string; request?: BenchRequest } {
  const data = load(cfg);
  const req = data.requests.find((r) => r.id === id);
  if (!req) return { ok: false, error: 'no such request' };
  if (req.status !== 'pending') return { ok: false, error: `that one is already ${req.status}` };

  if (!approve) {
    req.status = 'denied';
    req.decidedAt = Date.now();
    req.finishedAt = Date.now();
    req.output = 'the owner said no';
    save(cfg, data);
    return { ok: true, request: req };
  }

  if (data.requests.some((r) => r.status === 'running')) {
    return { ok: false, error: 'something is already running; one at a time' };
  }
  const who = lookup(cfg.bench.user);
  if (!who) {
    return { ok: false, error: `the sandbox user "${cfg.bench.user}" does not exist — run install/bench-sandbox.sh` };
  }

  req.status = 'running';
  req.decidedAt = Date.now();
  save(cfg, data);
  run(cfg, req, who);
  return { ok: true, request: req };
}

function run(cfg: Config, req: BenchRequest, who: Identity): void {
  const dir = benchDir(cfg);
  const drop = ['setpriv', `--reuid=${who.uid}`, `--regid=${who.gid}`, '--clear-groups', '--', 'sh', '-c', req.command];
  const isolated = haveUnshare();
  const bin = isolated ? 'unshare' : 'setpriv';
  const argv = isolated ? ['-n', '--', ...drop] : drop;

  let output = '';
  let settled = false;

  const finish = (status: BenchState, text: string, exitCode: number | null): void => {
    const data = load(cfg);
    const target = data.requests.find((r) => r.id === req.id);
    if (!target) return;
    target.status = status;
    target.output = text.slice(0, cfg.bench.maxOutputBytes);
    target.exitCode = exitCode;
    target.finishedAt = Date.now();
    save(cfg, data);
  };

  try {
    const child = spawn(bin, argv, {
      cwd: dir,
      detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, TMPDIR: dir, LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer): void => {
      if (output.length < cfg.bench.maxOutputBytes * 3) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      finish('failed', `${output.trim()}\n[timed out after ${Math.round(cfg.bench.timeoutMs / 1000)}s]`, null);
    }, cfg.bench.timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish('failed', err.message, null);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish(code === 0 ? 'done' : 'failed', output.trim() || '(no output)', code);
    });
  } catch (err) {
    finish('failed', (err as Error).message, null);
  }
}

/** Undelivered outcomes, marked delivered so he hears each one exactly once. */
export function collectResults(cfg: Config): BenchRequest[] {
  const data = load(cfg);
  const fresh = data.requests.filter(
    (r) => (r.status === 'done' || r.status === 'failed' || r.status === 'denied') && !r.delivered,
  );
  if (!fresh.length) return [];
  for (const r of fresh) r.delivered = true;
  save(cfg, data);
  return fresh;
}

export function benchStatus(cfg: Config): {
  enabled: boolean;
  user: string;
  userExists: boolean;
  isolated: boolean;
  pending: Array<{ id: string; command: string; note: string; day: number; at: number }>;
  recent: Array<{
    id: string;
    command: string;
    status: BenchState;
    output: string;
    exitCode: number | null | undefined;
    finishedAt: number | undefined;
  }>;
} {
  const who = lookup(cfg.bench.user);
  const data = load(cfg);
  const pending = data.requests.filter((r) => r.status === 'pending').sort((a, b) => a.at - b.at);
  const recent = data.requests
    .filter((r) => r.status !== 'pending')
    .sort((a, b) => (b.finishedAt ?? b.at) - (a.finishedAt ?? a.at))
    .slice(0, 8);
  return {
    enabled: cfg.bench.enabled,
    user: cfg.bench.user,
    userExists: Boolean(who),
    isolated: haveUnshare(),
    pending: pending.map(({ id, command, note, day, at }) => ({ id, command, note, day, at })),
    recent: recent.map(({ id, command, status, output, exitCode, finishedAt }) => ({
      id,
      command,
      status,
      output: (output ?? '').slice(0, 600),
      exitCode,
      finishedAt,
    })),
  };
}
