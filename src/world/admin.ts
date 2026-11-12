import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataPath, ROOT, type Config } from '../config.ts';
import { benchStatus } from '../bench.ts';

/**
 * The admin panel's data side: which keys are set, what the brain last reported,
 * and writing a new key into .env. It never returns a full key to the browser —
 * only four characters at each end — and it never restarts anything itself; it
 * drops a flag the brain watches.
 */

/** Only these may be edited from the panel. */
const EDITABLE = [
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'DEEPSEEK_API_KEY',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CHANNEL_ID',
] as const;

type KeyName = (typeof EDITABLE)[number];

function envFile(): string {
  return path.join(ROOT, '.env');
}

/** Keys the panel can show; anything else in .env is left alone. */
function readEnv(): Map<string, string> {
  const out = new Map<string, string>();
  const file = envFile();
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

function mask(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-1)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Created once, 0600, and printed in the world log on boot. */
export function adminToken(cfg: Config): string {
  const file = dataPath(cfg, 'admin-token');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token) return token;
  } catch {
    /* create it below */
  }
  const token = randomBytes(18).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function adminAuthorized(header: string | string[] | undefined, cfg: Config): boolean {
  const given = String(header ?? '');
  const token = adminToken(cfg);
  if (given.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export type AdminStatus = {
  ok: true;
  now: number;
  brain: unknown;
  keys: Record<string, { set: boolean; hint: string | null }>;
  config: {
    model: string;
    maxCallsPerDay: number;
    cooldownMinutes: number;
    heartbeatMinMs: number;
    heartbeatMaxMs: number;
    dataDir: string;
  };
  envFile: string;
  bench: ReturnType<typeof benchStatus>;
};

export function adminStatus(cfg: Config): AdminStatus {
  let brain: unknown = null;
  try {
    brain = JSON.parse(fs.readFileSync(dataPath(cfg, 'brain', 'status.json'), 'utf8'));
  } catch {
    brain = null;
  }
  const env = readEnv();
  const keys: Record<string, { set: boolean; hint: string | null }> = {};
  for (const name of EDITABLE) {
    const value = env.get(name);
    keys[name] = { set: Boolean(value), hint: mask(value) };
  }
  return {
    ok: true,
    now: Date.now(),
    brain,
    keys,
    config: {
      model: cfg.brain.model,
      maxCallsPerDay: cfg.brain.maxCallsPerDay,
      cooldownMinutes: cfg.brain.cooldownMinutes,
      heartbeatMinMs: cfg.brain.heartbeatMinMs,
      heartbeatMaxMs: cfg.brain.heartbeatMaxMs,
      dataDir: cfg.dataDir,
    },
    envFile: envFile(),
    bench: benchStatus(cfg),
  };
}

export type KeyUpdateResult = {
  ok: boolean;
  error?: string;
  updated?: string[];
  cleared?: string[];
  restartRequested?: boolean;
};

/**
 * Rewrites only the lines for the keys being changed, keeps the rest of the file
 * (comments included), leaves a .env.bak, and drops the reload flag.
 */
export function updateKeys(cfg: Config, updates: Record<string, unknown>): KeyUpdateResult {
  const wanted = Object.entries(updates).filter(([name]) => (EDITABLE as readonly string[]).includes(name));
  if (!wanted.length) return { ok: false, error: 'no editable key in the request' };

  const file = envFile();
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const updated: string[] = [];
  const cleared: string[] = [];

  for (const [name, raw] of wanted) {
    const value = String(raw ?? '')
      .replace(/[\r\n]/g, '')
      .trim()
      .slice(0, 512);
    const at = lines.findIndex((line) => {
      const bare = line.trim().replace(/^export\s+/, '');
      return bare.startsWith(`${name}=`);
    });
    if (value) {
      const line = `${name}=${value}`;
      if (at >= 0) lines[at] = line;
      else lines.push(line);
      updated.push(name);
    } else if (at >= 0) {
      lines[at] = `${name}=`;
      cleared.push(name);
    } else {
      lines.push(`${name}=`);
      cleared.push(name);
    }
  }

  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });

  // The brain deletes this and restarts itself under the supervisor.
  fs.writeFileSync(dataPath(cfg, 'brain', 'reload.request'), String(Date.now()));

  return { ok: true, updated, cleared, restartRequested: true };
}
