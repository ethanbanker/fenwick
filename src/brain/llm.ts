import fs from 'node:fs';
import type { BrainEndpoint, Config } from '../config.ts';
import { extractJson } from '../util/text.ts';

export type LlmCall = {
  system?: string;
  user: string;
  model?: 'quality' | 'fast' | 'vision';
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** absolute file paths of images to attach */
  images?: Array<{ path: string; mime: string }>;
};

export type LlmResult = {
  ok: boolean;
  text: string;
  error?: string;
  model: string;
  ms: number;
};

export type BudgetReport = {
  callsToday: number;
  max: number;
  remaining: number;
  exhausted: boolean;
  lastError: string | null;
};

/** One stage of the chain, as the admin panel sees it. No keys in here. */
export type EndpointUsage = {
  label: string;
  model: string;
  provider: string;
  keyed: boolean;
  calls: number;
  failures: number;
  lastStatus: number | null;
  lastMs: number | null;
  /** epoch ms; in the future while the stage is resting */
  coolingUntil: number | null;
};

export type LimitEvent = {
  at: number;
  label: string;
  model: string;
  kind: 'rate-limit' | 'error';
  /** how long the provider asked us to wait, when it said */
  waitMs: number | null;
  message: string;
};

export type BrainStatus = {
  pid: number;
  startedAt: number;
  updatedAt: number;
  dayKey: string;
  callsToday: number;
  maxCalls: number;
  exhausted: boolean;
  active: string;
  coolingDown: boolean;
  lastError: string | null;
  endpoints: EndpointUsage[];
  events: LimitEvent[];
};

type Endpoint = BrainEndpoint & { label: string };

/** Carries the provider's own retry hint out of the fetch layer. */
class EndpointError extends Error {
  retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * How long the provider says to wait: `Retry-After` (seconds or a date),
 * Gemini's RetryInfo `retryDelay`, or Groq's "try again in 7.6s" prose.
 * A per-minute limit answers in seconds, a spent daily quota in hours.
 */
function retryHintMs(headers: Headers, body: string): number | null {
  const header = headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const quoted = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (quoted) return Math.round(Number(quoted[1]) * 1000);
  const prose = /(?:try again|retry) in\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(body);
  if (prose) {
    const parts = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(prose[1]);
    if (parts) {
      const ms =
        (Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)) * 1000;
      if (ms > 0) return Math.round(ms);
    }
  }
  return null;
}

/** Keep a hint sane: never hot-loop, never idle past the next daily reset. */
function clampCooldown(ms: number): number {
  return Math.max(30_000, Math.min(ms, 24 * 3600_000));
}

export class Brain {
  private cfg: Config;
  private dayKey: string;
  private callsToday = 0;
  private lastCallAt = 0;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private endpointCooling = new Map<string, number>();
  private usage = new Map<string, EndpointUsage>();
  private events: LimitEvent[] = [];
  private startedAt = Date.now();

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.loadBudget();
    this.loadEvents();
    this.persistStatus();
  }

  private statusFile(): string {
    return `${this.cfg.dataDir}/brain/status.json`;
  }

  /** Recent limit events survive a restart, so the panel has history. */
  private loadEvents(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statusFile(), 'utf8')) as { events?: LimitEvent[] };
      if (Array.isArray(raw.events)) this.events = raw.events.slice(0, 80);
    } catch {
      /* first run */
    }
  }

  private usageFor(endpoint: Endpoint): EndpointUsage {
    let use = this.usage.get(endpoint.label);
    if (!use) {
      use = {
        label: endpoint.label,
        model: endpoint.model,
        provider: endpoint.provider,
        keyed: Boolean(endpoint.apiKey),
        calls: 0,
        failures: 0,
        lastStatus: null,
        lastMs: null,
        coolingUntil: null,
      };
      this.usage.set(endpoint.label, use);
    }
    use.model = endpoint.model;
    use.keyed = Boolean(endpoint.apiKey);
    return use;
  }

  private note(label: string, model: string, kind: 'rate-limit' | 'error', message: string, waitMs: number | null): void {
    this.events.unshift({ at: Date.now(), label, model, kind, waitMs, message: message.slice(0, 240) });
    if (this.events.length > 80) this.events.length = 80;
  }

  /** The chain, its counters and the recent limits — for the admin panel. */
  status(): BrainStatus {
    this.rollDay();
    const report = this.report();
    const seen = new Set<string>();
    const endpoints: EndpointUsage[] = [];
    for (const endpoint of this.endpoints()) {
      if (seen.has(endpoint.label)) continue;
      seen.add(endpoint.label);
      const use = this.usage.get(endpoint.label);
      endpoints.push({
        label: endpoint.label,
        model: endpoint.model,
        provider: endpoint.provider,
        keyed: Boolean(endpoint.apiKey),
        calls: use?.calls ?? 0,
        failures: use?.failures ?? 0,
        lastStatus: use?.lastStatus ?? null,
        lastMs: use?.lastMs ?? null,
        coolingUntil: this.endpointCooling.get(this.endpointId(endpoint)) ?? null,
      });
    }
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      dayKey: this.dayKey,
      callsToday: report.callsToday,
      maxCalls: report.max,
      exhausted: report.exhausted,
      active: this.activeLabel,
      coolingDown: this.coolingDown,
      lastError: report.lastError,
      endpoints,
      events: this.events.slice(0, 40),
    };
  }

  /** Written after every attempt so the panel is live, not a guess. */
  persistStatus(): void {
    try {
      fs.mkdirSync(`${this.cfg.dataDir}/brain`, { recursive: true });
      const file = this.statusFile();
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.status()));
      fs.renameSync(tmp, file);
    } catch {
      /* non-fatal: the panel is a convenience, not the brain */
    }
  }

  private budgetFile(): string {
    return `${this.cfg.dataDir}/brain/budget.json`;
  }

  private loadBudget(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.budgetFile(), 'utf8')) as { day: string; calls: number };
      if (raw.day === this.dayKey) this.callsToday = raw.calls ?? 0;
    } catch {
      /* first run */
    }
  }

  private saveBudget(): void {
    try {
      fs.mkdirSync(`${this.cfg.dataDir}/brain`, { recursive: true });
      fs.writeFileSync(this.budgetFile(), JSON.stringify({ day: this.dayKey, calls: this.callsToday }));
    } catch {
      /* non-fatal */
    }
  }

  private rollDay(): void {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.callsToday = 0;
      this.lastError = null;
      this.endpointCooling.clear();
      this.usage.clear();
      this.saveBudget();
    }
  }

  report(): BudgetReport {
    this.rollDay();
    const max = this.cfg.brain.maxCallsPerDay;
    return {
      callsToday: this.callsToday,
      max,
      remaining: Math.max(0, max - this.callsToday),
      exhausted: this.callsToday >= max,
      lastError: this.lastError,
    };
  }

  private endpointId(endpoint: BrainEndpoint): string {
    return `${endpoint.provider}|${endpoint.baseUrl}|${endpoint.model}|${endpoint.apiKey}`;
  }

  private isCooling(endpoint: BrainEndpoint): boolean {
    return Date.now() < (this.endpointCooling.get(this.endpointId(endpoint)) ?? 0);
  }

  private endpoints(call?: LlmCall): Endpoint[] {
    const b = this.cfg.brain;
    // Keep the ordered array authoritative. The old singular fallback is only
    // appended for configs that predate `fallbacks` and are not already present.
    const candidates: Array<{ endpoint: BrainEndpoint; label: string }> = [
      { endpoint: b, label: b.name ?? b.provider },
      ...b.fallbacks.map((f) => ({ endpoint: f, label: f.name ?? `${f.provider} fallback` })),
      { endpoint: b.fallback, label: b.fallback.name ?? `${b.fallback.provider} fallback` },
    ];
    const list: Endpoint[] = [];
    const seen = new Set<string>();
    for (const { endpoint, label } of candidates) {
      if (!endpoint) continue;
      const id = this.endpointId(endpoint);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ ...endpoint, label });
    }

    // Gemini is the known vision endpoint. If a picture is attached, let it go
    // first even when another provider is currently the active text model.
    if (call?.images?.length) {
      const rank = (e: Endpoint) => (e.provider === 'gemini' ? 0 : 1);
      list.sort((a, b2) => rank(a) - rank(b2));
    }
    return list;
  }

  get keyPresent(): boolean {
    return this.endpoints().some((e) => Boolean(e.apiKey));
  }

  /** The endpoint that will actually serve the next call, including fallbacks. */
  get activeLabel(): string {
    const endpoint = this.endpoints().find((e) => e.apiKey && !this.isCooling(e));
    if (!endpoint) return this.keyPresent ? 'all endpoints cooling' : 'reflex only';
    return `${endpoint.label}/${this.modelFor('fast', endpoint)}`;
  }

  /** Ordered free-or-paid chain, for startup logs. */
  get chainLabel(): string {
    const chain = this.endpoints()
      .filter((e) => e.apiKey)
      .map((e) => `${e.label}/${e.fastModel || e.model}`);
    return chain.length ? chain.join(' -> ') : 'reflex only';
  }

  /** True only when every keyed endpoint is cooling; one available provider is enough. */
  get coolingDown(): boolean {
    const endpoints = this.endpoints().filter((e) => e.apiKey);
    return endpoints.length > 0 && endpoints.every((e) => this.isCooling(e));
  }

  /** Serialises calls and enforces the pacing floor. */
  async complete(call: LlmCall): Promise<LlmResult> {
    const run = async (): Promise<LlmResult> => {
      const startedAt = Date.now();
      const kind = call.model ?? 'quality';
      const endpoints = this.endpoints(call);
      const primaryName = this.modelFor(kind, endpoints[0]);
      const budget = this.report();
      if (!this.keyPresent) {
        return { ok: false, text: '', error: 'no-api-key', model: primaryName, ms: 0 };
      }
      if (budget.exhausted) {
        return { ok: false, text: '', error: 'daily-budget-reached', model: primaryName, ms: 0 };
      }
      if (this.keyPresent && endpoints.every((e) => !e.apiKey || this.isCooling(e))) {
        return { ok: false, text: '', error: 'all-endpoints-cooling', model: primaryName, ms: 0 };
      }
      const since = Date.now() - this.lastCallAt;
      const minGap = this.cfg.brain.minSecondsBetweenCalls * 1000;
      if (since < minGap) await sleep(minGap - since);

      let lastErr = '';
      let lastModel = primaryName;
      for (const endpoint of endpoints) {
        if (!endpoint.apiKey) {
          lastErr = lastErr || `${endpoint.label} has no api key`;
          continue;
        }
        if (this.isCooling(endpoint)) {
          lastErr = `${endpoint.label} is cooling down`;
          continue;
        }
        const modelName = this.modelFor(kind, endpoint);
        lastModel = modelName;

        // Two goes per endpoint: one immediate, one after a short wait. Then
        // move down the chain, so a dead primary does not use the whole day.
        for (let attempt = 0; attempt < 2; attempt++) {
          this.lastCallAt = Date.now();
          try {
            const text =
              endpoint.provider === 'gemini'
                ? await this.callGemini(endpoint, modelName, call)
                : await this.callOpenAi(endpoint, modelName, call);
            this.callsToday += 1;
            this.saveBudget();
            this.lastError = null;
            const good = this.usageFor(endpoint);
            good.calls += 1;
            good.lastStatus = 200;
            good.lastMs = Date.now() - startedAt;
            this.persistStatus();
            return { ok: true, text, model: modelName, ms: Date.now() - startedAt };
          } catch (err) {
            const message = (err as Error).message;
            lastErr = `${endpoint.label}: ${message}`;
            const quota = /429|rate.?limit|quota|per.?day|daily limit|too many requests/i.test(message);
            if (quota) {
              // Trust the provider's hint when there is one: a per-minute limit is
              // back in seconds, a spent daily quota not until tomorrow. A flat
              // guess either hammers the daily limit or idles a healthy endpoint.
              const hint = (err as EndpointError).retryAfterMs;
              const waitMs = clampCooldown(hint ?? this.cfg.brain.cooldownMinutes * 60_000);
              this.endpointCooling.set(this.endpointId(endpoint), Date.now() + waitMs);
              lastErr += ` (skipped ${Math.round(waitMs / 1000)}s)`;
              const limited = this.usageFor(endpoint);
              limited.failures += 1;
              limited.lastStatus = 429;
              this.note(endpoint.label, modelName, 'rate-limit', message, waitMs);
              break;
            }
            const retriable = /503|502|timeout|overloaded|EAI_AGAIN|fetch failed/i.test(message);
            if (!retriable || attempt >= 1) {
              const failed = this.usageFor(endpoint);
              failed.failures += 1;
              failed.lastStatus = Number(/\b(\d{3})\b/.exec(message)?.[1] ?? 0) || null;
              this.note(endpoint.label, modelName, 'error', message, null);
              break;
            }
            await sleep(1500 + Math.random() * 800);
          }
        }
      }

      // A refused request costs nothing, so it must not spend the day's budget.
      this.lastError = lastErr || 'all endpoints failed';
      this.persistStatus();
      return { ok: false, text: '', error: this.lastError, model: lastModel, ms: Date.now() - startedAt };
    };

    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => undefined);
    return chained;
  }

  async json<T>(call: LlmCall): Promise<{ ok: boolean; data: T | null; error?: string; raw: string }> {
    const res = await this.complete({ ...call, json: true });
    if (!res.ok) return { ok: false, data: null, error: res.error, raw: '' };
    const data = extractJson<T>(res.text);
    return { ok: Boolean(data), data, raw: res.text, error: data ? undefined : 'could not parse json' };
  }

  private modelFor(kind: 'quality' | 'fast' | 'vision', endpoint: Endpoint): string {
    const remaining = this.report().remaining;
    if (kind === 'vision') return endpoint.visionModel || endpoint.model;
    if (kind === 'fast') return endpoint.fastModel || endpoint.model;
    // low reserve: downgrade quality calls
    if (remaining <= this.cfg.brain.reserveCalls) return endpoint.fastModel || endpoint.model;
    return endpoint.model;
  }

  private imageParts(call: LlmCall): Array<{ mimeType: string; data: string }> {
    const out: Array<{ mimeType: string; data: string }> = [];
    for (const img of call.images ?? []) {
      try {
        const buf = fs.readFileSync(img.path);
        if (buf.length > 5_500_000) continue;
        out.push({ mimeType: img.mime, data: buf.toString('base64') });
      } catch {
        /* skip unreadable image */
      }
    }
    return out;
  }

  private async callGemini(endpoint: Endpoint, model: string, call: LlmCall): Promise<string> {
    const url = `${endpoint.baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
      endpoint.apiKey,
    )}`;
    const parts: Array<Record<string, unknown>> = [{ text: call.user }];
    for (const img of this.imageParts(call)) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: call.temperature ?? this.cfg.brain.temperature,
        maxOutputTokens: call.maxTokens ?? 900,
        ...(call.json ? { responseMimeType: 'application/json' } : {}),
      },
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };
    if (call.system) body.systemInstruction = { parts: [{ text: call.system }] };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new EndpointError(`gemini ${res.status}: ${text.slice(0, 300)}`, retryHintMs(res.headers, text));
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
    if (data.promptFeedback?.blockReason) throw new Error(`blocked: ${data.promptFeedback.blockReason}`);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) throw new Error(`empty response (${cand?.finishReason ?? 'no candidate'})`);
    return text;
  }

  private async callOpenAi(endpoint: Endpoint, model: string, call: LlmCall): Promise<string> {
    const base = endpoint.baseUrl.replace(/\/$/, '');
    const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: call.user }];
    for (const img of this.imageParts(call)) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
    }
    const body: Record<string, unknown> = {
      model,
      messages: [
        ...(call.system ? [{ role: 'system', content: call.system }] : []),
        { role: 'user', content: call.images?.length ? content : call.user },
      ],
      temperature: call.temperature ?? this.cfg.brain.temperature,
      max_tokens: call.maxTokens ?? 900,
      ...(call.json && endpoint.jsonMode !== false ? { response_format: { type: 'json_object' } } : {}),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
        ...(endpoint.baseUrl.includes('openrouter.ai')
          ? { 'HTTP-Referer': 'https://github.com/ethanbanker/fenwick', 'X-Title': 'Fenwick' }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new EndpointError(`openai ${res.status}: ${text.slice(0, 300)}`, retryHintMs(res.headers, text));
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('empty response');
    return text;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
