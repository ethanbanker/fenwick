const STOPWORDS = new Set(
  (
    'the a an and or but if then than so because as of at by for with about against between into ' +
    'through during before after above below to from up down in out on off over under again further ' +
    'once here there when where why how all any both each few more most other some such no nor not ' +
    'only own same too very can will just should now is are was were be been being have has had do ' +
    'does did doing would could shall may might must i me my we our you your he him his she her it ' +
    'its they them their this that these those what which who whom am also get got go went going ' +
    'like really quite thing things something anything nothing everything one two three'
  ).split(' '),
);

/** Strips scripts/styles/tags and collapses whitespace. */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    hellip: '…',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]).slice(0, 160) : '';
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const w of tokenize(text)) {
    const clean = w.replace(/^-+|-+$/g, '');
    if (clean.length < 3) continue;
    if (STOPWORDS.has(clean)) continue;
    out.push(stem(clean));
  }
  return out;
}

/** Crude, deterministic stemmer: enough to catch "glowing"/"glow" as one subject. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

export function oneLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Extract the first JSON object/array from a model reply that may be fenced. */
export function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(raw);
  for (const c of candidates) {
    const trimmed = c.trim();
    const start = findStart(trimmed);
    if (start < 0) continue;
    const balanced = sliceBalanced(trimmed, start);
    if (!balanced) continue;
    try {
      return JSON.parse(balanced) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}

function findStart(s: string): number {
  const a = s.indexOf('{');
  const b = s.indexOf('[');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function sliceBalanced(s: string, start: number): string | null {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function pick<T>(arr: T[], rng: () => number = Math.random): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Deterministic PRNG so a town seed always builds the same town. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
