import fs from 'node:fs';
import path from 'node:path';

export type ProviderName = 'gemini' | 'openai';

export type BrainEndpoint = {
  /** Short label used in logs, e.g. "gemini" or "groq". */
  name?: string;
  provider: ProviderName;
  apiKey: string;
  model: string;
  fastModel: string;
  visionModel: string;
  baseUrl: string;
  /** Some free routers reject response_format; the prompts still ask for JSON. */
  jsonMode?: boolean;
};

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
    /** Minutes to skip a provider after it reports a rate or daily quota limit. */
    cooldownMinutes: number;
    /** Legacy singular fallback; only appended when absent from `fallbacks`. */
    fallback: BrainEndpoint;
    /** Free or paid endpoints tried in this exact order after the primary. */
    fallbacks: BrainEndpoint[];
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
  discord: {
    /** Bot token from the Discord developer portal. Empty means the bridge is off. */
    token: string;
    /** The channel he reads and speaks in. */
    channelId: string;
    /** Post each finished diary entry to that channel. */
    announceDiaries: boolean;
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

const GEMINI_FALLBACK: BrainEndpoint = {
  name: 'gemini',
  provider: 'gemini',
  apiKey: '',
  // Google's rolling aliases follow current models, avoiding deprecation 404s.
  // Lite is the reliable free-tier path; Flash is currently capacity-limited.
  model: 'gemini-flash-lite-latest',
  fastModel: 'gemini-flash-lite-latest',
  visionModel: 'gemini-flash-lite-latest',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
};

const GROQ_FALLBACK: BrainEndpoint = {
  name: 'groq',
  provider: 'openai',
  apiKey: '',
  model: 'openai/gpt-oss-120b',
  fastModel: 'openai/gpt-oss-20b',
  visionModel: 'openai/gpt-oss-120b',
  baseUrl: 'https://api.groq.com/openai/v1',
};

const OPENROUTER_FALLBACK: BrainEndpoint = {
  name: 'openrouter',
  provider: 'openai',
  apiKey: '',
  model: 'openrouter/free',
  fastModel: 'openrouter/free',
  visionModel: 'openrouter/free',
  baseUrl: 'https://openrouter.ai/api/v1',
  jsonMode: false,
};

const DEFAULTS: Config = {
  port: 4321,
  host: '0.0.0.0',
  dataDir: 'data',
  creature: { name: 'Mochi', species: 'cat', pronouns: 'he' },
  town: { name: 'Fenwick' },
  sim: { tickHz: 20, dayLengthMinutes: 60, seed: 1337 },
  brain: {
    // Gemini leads: strongest free model, and the only stage that reads images.
    // DeepSeek Flash still takes the front of the chain when DEEPSEEK_API_KEY is set.
    provider: 'gemini',
    apiKey: '',
    model: GEMINI_FALLBACK.model,
    fastModel: GEMINI_FALLBACK.fastModel,
    visionModel: GEMINI_FALLBACK.visionModel,
    baseUrl: GEMINI_FALLBACK.baseUrl,
    temperature: 1.0,
    heartbeatMinMs: 4000,
    heartbeatMaxMs: 15000,
    maxCallsPerDay: 2000,
    minSecondsBetweenCalls: 6,
    reserveCalls: 40,
    cooldownMinutes: 20,
    fallback: { ...GROQ_FALLBACK },
    fallbacks: [
      { ...GEMINI_FALLBACK },
      { ...GROQ_FALLBACK },
      { ...OPENROUTER_FALLBACK },
    ],
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
  discord: { token: '', channelId: '', announceDiaries: true },
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

  // DeepSeek is the default brain. Its API is OpenAI-compatible, so it needs
  // no special adapter; GEMINI_API_KEY stays configured as the safety net.
  const explicitProvider = env.LLM_PROVIDER === 'gemini' || env.LLM_PROVIDER === 'openai';
  if (!explicitProvider && env.DEEPSEEK_API_KEY) {
    cfg.brain.provider = 'openai';
    cfg.brain.baseUrl = env.LLM_BASE_URL ?? 'https://api.deepseek.com';
    if (!env.LLM_MODEL) cfg.brain.model = 'deepseek-flash';
    if (!env.LLM_FAST_MODEL) cfg.brain.fastModel = cfg.brain.model;
    if (!env.LLM_VISION_MODEL) cfg.brain.visionModel = cfg.brain.model;
  }

  if (env.LLM_API_KEY) cfg.brain.apiKey = env.LLM_API_KEY;
  else if (env.DEEPSEEK_API_KEY && cfg.brain.provider === 'openai') cfg.brain.apiKey = env.DEEPSEEK_API_KEY;
  else if (env.GEMINI_API_KEY && cfg.brain.provider === 'gemini') cfg.brain.apiKey = env.GEMINI_API_KEY;
  else if (env.OPENAI_API_KEY && cfg.brain.provider === 'openai') cfg.brain.apiKey = env.OPENAI_API_KEY;

  // Clone the endpoint objects before env overrides so tests and repeated
  // config loads never mutate the shared defaults.
  cfg.brain.fallback = { ...cfg.brain.fallback };
  cfg.brain.fallbacks = cfg.brain.fallbacks.map((f) => ({ ...f }));
  for (const base of [GROQ_FALLBACK, GEMINI_FALLBACK, OPENROUTER_FALLBACK]) {
    if (!cfg.brain.fallbacks.some((f) => f.name === base.name)) {
      cfg.brain.fallbacks.push({ ...base });
    }
  }
  const fallbackFor = (name: string) => cfg.brain.fallbacks.find((f) => f.name === name)!;

  // The legacy singular `fallback` is the Groq stage now, so only the named
  // entry takes the Gemini key. GEMINI_* overrides follow the primary too.
  const geminiLeads = cfg.brain.provider === 'gemini';
  if (env.GEMINI_API_KEY) fallbackFor('gemini').apiKey = env.GEMINI_API_KEY;
  if (env.GEMINI_MODEL) {
    fallbackFor('gemini').model = env.GEMINI_MODEL;
    if (geminiLeads && !env.LLM_MODEL) cfg.brain.model = env.GEMINI_MODEL;
  }
  if (env.GEMINI_FAST_MODEL) {
    fallbackFor('gemini').fastModel = env.GEMINI_FAST_MODEL;
    if (geminiLeads && !env.LLM_FAST_MODEL) cfg.brain.fastModel = env.GEMINI_FAST_MODEL;
  }
  if (env.GEMINI_VISION_MODEL) {
    fallbackFor('gemini').visionModel = env.GEMINI_VISION_MODEL;
    if (geminiLeads && !env.LLM_VISION_MODEL) cfg.brain.visionModel = env.GEMINI_VISION_MODEL;
  }

  if (env.GROQ_API_KEY) fallbackFor('groq').apiKey = env.GROQ_API_KEY;
  if (env.GROQ_MODEL) fallbackFor('groq').model = env.GROQ_MODEL;
  if (env.GROQ_FAST_MODEL) fallbackFor('groq').fastModel = env.GROQ_FAST_MODEL;
  if (env.GROQ_VISION_MODEL) fallbackFor('groq').visionModel = env.GROQ_VISION_MODEL;
  if (env.GROQ_BASE_URL) fallbackFor('groq').baseUrl = env.GROQ_BASE_URL;

  if (env.OPENROUTER_API_KEY) fallbackFor('openrouter').apiKey = env.OPENROUTER_API_KEY;
  if (env.OPENROUTER_MODEL) fallbackFor('openrouter').model = env.OPENROUTER_MODEL;
  if (env.OPENROUTER_FAST_MODEL) fallbackFor('openrouter').fastModel = env.OPENROUTER_FAST_MODEL;
  if (env.OPENROUTER_VISION_MODEL) fallbackFor('openrouter').visionModel = env.OPENROUTER_VISION_MODEL;
  if (env.OPENROUTER_BASE_URL) fallbackFor('openrouter').baseUrl = env.OPENROUTER_BASE_URL;

  if (env.DISCORD_BOT_TOKEN) cfg.discord.token = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_CHANNEL_ID) cfg.discord.channelId = env.DISCORD_CHANNEL_ID;
  if (env.DISCORD_ANNOUNCE_DIARIES === '0' || env.DISCORD_ANNOUNCE_DIARIES === 'false') {
    cfg.discord.announceDiaries = false;
  }

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
