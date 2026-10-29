import fs from 'node:fs';
import type { Config } from '../config.ts';
import type { Brain } from './llm.ts';
import { contentWords, decodeEntities, htmlToText, pageTitle, truncate } from '../util/text.ts';

export type Reading = {
  at: number;
  day: number;
  url: string;
  title: string;
  summary: string;
  opinion: number;
  tags: string[];
  quote: string;
  stayed: boolean;
};

export type Interests = {
  tags: Record<string, number>;
  updatedAt: number;
};

const FALLBACK_URLS = [
  'https://en.wikipedia.org/wiki/Special:Random',
  'https://en.wikipedia.org/wiki/Special:Random',
  'https://news.ycombinator.com/',
  'https://www.gutenberg.org/ebooks/search/?sort_order=random',
  'https://publicdomainreview.org/',
];

function interestsPath(cfg: Config): string {
  return `${cfg.dataDir}/brain/interests.json`;
}

function readingsPath(cfg: Config): string {
  return `${cfg.dataDir}/brain/readings.json`;
}

export function loadInterests(cfg: Config): Interests {
  try {
    return JSON.parse(fs.readFileSync(interestsPath(cfg), 'utf8')) as Interests;
  } catch {
    return { tags: {}, updatedAt: Date.now() };
  }
}

function saveInterests(cfg: Config, interests: Interests): void {
  fs.mkdirSync(`${cfg.dataDir}/brain`, { recursive: true });
  interests.updatedAt = Date.now();
  fs.writeFileSync(interestsPath(cfg), JSON.stringify(interests, null, 2));
}

export function loadReadings(cfg: Config): Reading[] {
  try {
    const raw = JSON.parse(fs.readFileSync(readingsPath(cfg), 'utf8')) as Reading[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveReading(cfg: Config, reading: Reading): void {
  const all = loadReadings(cfg);
  all.push(reading);
  fs.mkdirSync(`${cfg.dataDir}/brain`, { recursive: true });
  fs.writeFileSync(readingsPath(cfg), JSON.stringify(all.slice(-120), null, 2));
}

export function topInterests(interests: Interests, n = 5): string[] {
  const now = Date.now();
  const days = Math.max(0, (now - interests.updatedAt) / 86_400_000);
  return Object.entries(interests.tags)
    .map(([tag, w]) => [tag, w * Math.pow(0.97, days)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .filter(([, w]) => w > 0.15)
    .map(([tag]) => tag);
}

function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '0.0.0.0' || h === '::1' || h.includes('metadata.google')) return true;
  return false;
}

export async function fetchPage(
  cfg: Config,
  url: string,
): Promise<{ ok: boolean; url: string; title: string; text: string; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, title: '', text: '', error: 'not a url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, url, title: '', text: '', error: 'only http(s)' };
  }
  if (privateHost(parsed.hostname)) {
    return { ok: false, url, title: '', text: '', error: 'he is not allowed to poke around the house network' };
  }
  try {
    const res = await fetch(parsed, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; FenwickBot/1.0; a small owl)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(cfg.browse.timeoutMs),
    });
    if (!res.ok) return { ok: false, url, title: '', text: '', error: `http ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain/i.test(type)) {
      return { ok: false, url, title: '', text: '', error: `not a page (${type.split(';')[0]})` };
    }
    const raw = (await res.text()).slice(0, cfg.browse.maxBytes);
    const text = htmlToText(raw);
    return { ok: true, url: res.url || url, title: pageTitle(raw) || parsed.hostname, text, error: undefined };
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, url, title: '', text: '', error: /timeout|abort/i.test(msg) ? 'timed out' : msg };
  }
}

async function search(cfg: Config, query: string): Promise<string[]> {
  if (!cfg.browse.allowSearch) return [];
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; FenwickBot/1.0)',
        accept: 'text/html',
      },
      signal: AbortSignal.timeout(cfg.browse.timeoutMs),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const urls: string[] = [];
    const re = /uddg=([^&"']+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      try {
        const u = decodeURIComponent(m[1]);
        if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u);
      } catch {
        /* skip */
      }
      if (urls.length >= 8) break;
    }
    return urls;
  } catch {
    return [];
  }
}

export type BrowseOutcome = {
  ok: boolean;
  tried: Array<{ url: string; ok: boolean; error?: string }>;
  reading: Reading | null;
  error?: string;
};

/** One browsing session: decide what to look for, actually fetch it, then react in character. */
export async function browseSession(args: {
  cfg: Config;
  brain: Brain;
  day: number;
  personaBrief: string;
  memoryDigest: string;
}): Promise<BrowseOutcome> {
  const { cfg, brain, day, personaBrief: brief, memoryDigest } = args;
  const interests = loadInterests(cfg);
  const known = topInterests(interests);
  const tried: BrowseOutcome['tried'] = [];

  if (!cfg.browse.enabled) return { ok: false, tried, reading: null, error: 'browsing disabled' };

  let query = '';
  const pick = await brain.json<{ query: string; because?: string }>({
    system: brief,
    user: [
      'You are about to look something up on the internet, sitting in the laundrette with a small screen.',
      known.length ? `Things you have been reading about lately: ${known.join(', ')}.` : 'You have not read much yet.',
      memoryDigest ? `What is on your mind:\n${truncate(memoryDigest, 700)}` : '',
      '',
      'Give yourself one search query. Something you actually want to know, in your own curiosity — not a test, not a chore.',
      'Short, 2 to 6 words, no quotation marks. Reply with JSON: {"query":"..."}',
    ]
      .filter(Boolean)
      .join('\n'),
    model: 'fast',
    json: true,
    maxTokens: 120,
    temperature: 1.0,
  });
  if (pick.data?.query) query = String(pick.data.query).slice(0, 90);

  let candidates = query ? await search(cfg, query) : [];
  if (!candidates.length) candidates = FALLBACK_URLS.slice();
  candidates = candidates.slice(0, 4);

  let page: { ok: boolean; url: string; title: string; text: string; error?: string } | null = null;
  for (const url of candidates) {
    const fetched = await fetchPage(cfg, url);
    tried.push({ url, ok: fetched.ok, error: fetched.error });
    if (fetched.ok && fetched.text.length > 400) {
      page = fetched;
      break;
    }
    if (tried.length >= cfg.browse.maxFetchesPerSession) break;
  }
  if (!page) {
    return { ok: false, tried, reading: null, error: 'nothing he tried actually loaded' };
  }

  const reaction = await brain.json<{
    summary: string;
    opinion: number;
    tags: string[];
    quote: string;
    stayed: boolean;
  }>({
    system:
      `${brief}\n\nYou are reading a page on the internet. React as yourself. ` +
      'If it is boring, say so and leave. You are allowed to dislike things.',
    user: [
      `You searched for: ${query || '(nothing in particular, you just clicked something)'}`,
      `Page title: ${page.title}`,
      `URL: ${page.url}`,
      '',
      'Page text:',
      truncate(page.text, 3500),
      '',
      'Reply with JSON only:',
      '{"summary":"one or two flat sentences about what this page actually is","opinion":-1..1,"tags":["2-4 single word topics"],"quote":"a short phrase from the page worth keeping, verbatim","stayed":true}',
      'opinion is how you felt about it: negative means you wished you had not opened it.',
    ].join('\n'),
    model: 'fast',
    json: true,
    maxTokens: 400,
    temperature: 1.0,
  });

  const r = reaction.data;
  const reading: Reading = {
    at: Date.now(),
    day,
    url: page.url,
    title: page.title.slice(0, 160),
    summary: String(r?.summary ?? '').slice(0, 400) || 'a page with nothing much on it',
    opinion: typeof r?.opinion === 'number' ? Math.max(-1, Math.min(1, r.opinion)) : 0,
    tags: Array.isArray(r?.tags) ? r.tags.slice(0, 5).map((t) => String(t).toLowerCase().slice(0, 24)) : [],
    quote: String(r?.quote ?? '').slice(0, 240),
    stayed: r?.stayed !== false,
  };
  saveReading(cfg, reading);

  // interest profile accumulates, weighted, and forgets slowly
  for (const tag of reading.tags) {
    const gain = 0.45 * (1 + reading.opinion);
    interests.tags[tag] = Math.max(0, (interests.tags[tag] ?? 0) * 0.94 + gain);
  }
  for (const w of contentWords(reading.title).slice(0, 4)) {
    interests.tags[w] = Math.max(0, (interests.tags[w] ?? 0) * 0.96 + 0.08);
  }
  const trimmed = Object.entries(interests.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60);
  interests.tags = Object.fromEntries(trimmed);
  saveInterests(cfg, interests);

  return { ok: true, tried, reading };
}
