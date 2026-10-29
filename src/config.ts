import fs from 'node:fs';
import path from 'node:path';

export type ProviderName = 'gemini' | 'openai';

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  creature: {
    name: string;
    species: string;
    pronouns: string;
  };
  town: {
    name: string;
  };
  sim: {
    tickHz: number;
    /** Real minutes that make up one in-world day. */
    dayLengthMinutes: number;
    seed: number;
  };
  brain: {
    provider: ProviderName;
    apiKey: string;
    model: string;
    fastModel: string;
    visionModel: string;
    baseUrl: string;
    temperature: number;
    heartbeatMinMs: number;
    heartbeatMaxMs: number;
    /** Hard daily ceiling on model calls, so a free tier is never exhausted. */
    maxCallsPerDay: number;
    minSecondsBetweenCalls: number;
    /** Below this many calls left in the day, only the fast model is used. */
    reserveCalls: number;
  };
  memory: {
    slotsPerSection: number;
    halfLifeDays: number;
    subjectCeiling: number;
    pairCeiling: number;
    logRetentionDays: number;
  };
  offerings: {
    perDayLimit: number;
    spawnRadiusTiles: number;
    senseRadiusTiles: number;
  };
  browse: {
    enabled: boolean;
    allowSearch: boolean;
    maxFetchesPerSession: number;
    timeoutMs: number;
    maxBytes: number;
  };
};

function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override as T;
  if (typeof override !== 'object' || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (k in out) out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

/** Minimal `.env` reader so the project needs no dependencies. */
export function loadEnvFile(file = '.env'): void {
  if (!fs.existsSync(file)) return;
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
    if (!(key in process.env)) process.env[key] = value;
  }
}

const DEFAULTS: Config = {
  port: 4321,
  host: '0.0.0.0',
  dataDir: 'data',
  creature: { name: 'Mochi', species: 'owl', pronouns: 'he' },
  town: { name: 'Fenwick' },
  sim: { tickHz: 20, dayLengthMinutes: 60, seed: 1337 },
  brain: {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-2.5-flash',
    fastModel: 'gemini-2.5-flash-lite',
    visionModel: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    temperature: 1.0,
    heartbeatMinMs: 4000,
    heartbeatMaxMs: 15000,
    maxCallsPerDay: 350,
    minSecondsBetweenCalls: 6,
    reserveCalls: 40,
  },
  memory: {
    slotsPerSection: 24,
    halfLifeDays: 21,
    subjectCeiling: 4,
    pairCeiling: 2,
    logRetentionDays: 7,
  },
  offerings: {
    perDayLimit: 3,
    spawnRadiusTiles: 9,
    senseRadiusTiles: 3,
  },
  browse: {
    enabled: true,
    allowSearch: true,
    maxFetchesPerSession: 3,
    timeoutMs: 12000,
    maxBytes: 400_000,
  },
};

export const ROOT = path.resolve(process.cwd());

export function configPath(): string {
  return path.join(ROOT, 'config.json');
}

export function loadConfig(): Config {
  loadEnvFile(path.join(ROOT, '.env'));
  let raw: unknown = {};
  const p = configPath();
  if (fs.existsSync(p)) {
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.error(`[config] could not parse config.json: ${(err as Error).message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, raw);

  const env = process.env;
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.HOST) cfg.host = env.HOST;
  if (env.DATA_DIR) cfg.dataDir = env.DATA_DIR;
  if (env.LLM_PROVIDER === 'gemini' || env.LLM_PROVIDER === 'openai') cfg.brain.provider = env.LLM_PROVIDER;
  if (env.LLM_MODEL) cfg.brain.model = env.LLM_MODEL;
  if (env.LLM_FAST_MODEL) cfg.brain.fastModel = env.LLM_FAST_MODEL;
  if (env.LLM_VISION_MODEL) cfg.brain.visionModel = env.LLM_VISION_MODEL;
  if (env.LLM_BASE_URL) cfg.brain.baseUrl = env.LLM_BASE_URL;
  if (env.LLM_API_KEY) cfg.brain.apiKey = env.LLM_API_KEY;
  else if (cfg.brain.provider === 'gemini' && env.GEMINI_API_KEY) cfg.brain.apiKey = env.GEMINI_API_KEY;
  else if (env.OPENAI_API_KEY) cfg.brain.apiKey = env.OPENAI_API_KEY;

  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  return cfg;
}

export function dataPath(cfg: Config, ...parts: string[]): string {
  const full = path.join(cfg.dataDir, ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

export function ensureDir(cfg: Config, ...parts: string[]): string {
  const dir = path.join(cfg.dataDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
