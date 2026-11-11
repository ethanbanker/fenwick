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

type Endpoint = BrainEndpoint & { label: string };

export class Brain {
  private cfg: Config;
  private dayKey: string;
  private callsToday = 0;
  private lastCallAt = 0;
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disabledUntil = 0;

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.dayKey = new Date().toISOString().slice(0, 10);
    this.loadBudget();
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
      this.disabledUntil = 0;
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

  private endpoints(call?: LlmCall): Endpoint[] {
    const b = this.cfg.brain;
    const primary: Endpoint = {
      provider: b.provider,
      apiKey: b.apiKey,
      model: b.model,
      fastModel: b.fastModel,
      visionModel: b.visionModel,
      baseUrl: b.baseUrl,
      label: b.provider,
    };
    const f = b.fallback;
    const distinct = f.apiKey && (f.provider !== b.provider || f.baseUrl !== b.baseUrl || f.model !== b.model);
    const list: Endpoint[] = [primary];
    if (distinct) list.push({ ...f, label: `${f.provider} fallback` });

    // Only Gemini is assumed to accept image input. If a picture is attached,
    // let the vision-capable endpoint go first even if it is the backup.
    if (call?.images?.length) {
      const rank = (e: Endpoint) => (e.provider === 'gemini' ? 0 : 1);
      list.sort((a, b2) => rank(a) - rank(b2));
    }
    return list;
  }

  get keyPresent(): boolean {
    return this.endpoints().some((e) => Boolean(e.apiKey));
  }

  /** True while he is sitting out a rate limit; no point calling the model. */
  get coolingDown(): boolean {
    return Date.now() < this.disabledUntil;
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
      if (Date.now() < this.disabledUntil) {
        return { ok: false, text: '', error: 'backing-off', model: primaryName, ms: 0 };
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
            return { ok: true, text, model: modelName, ms: Date.now() - startedAt };
          } catch (err) {
            const message = (err as Error).message;
            lastErr = `${endpoint.label}: ${message}`;
            const retriable = /429|rate|quota|503|502|timeout|overloaded|EAI_AGAIN|fetch failed/i.test(message);
            if (!retriable || attempt >= 1) break;
            await sleep(1500 + Math.random() * 800);
          }
        }
      }

      this.callsToday += 1;
      this.saveBudget();
      this.lastError = lastErr || 'all endpoints failed';
      if (/429|rate|quota|per.?day/i.test(lastErr)) {
        // both the primary and the backup are out of room; reflex keeps him alive
        this.disabledUntil = Date.now() + 20 * 60_000;
      }
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
      throw new Error(`gemini ${res.status}: ${text.slice(0, 300)}`);
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
      ...(call.json ? { response_format: { type: 'json_object' } } : {}),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai ${res.status}: ${text.slice(0, 300)}`);
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
