import fs from 'node:fs';
import type { Config } from '../config.ts';
import { contentWords, stem } from '../util/text.ts';

export type PersonaSheet = {
  name: string;
  species: string;
  pronouns: string;
  traits: string[];
  values: string[];
  fears: string[];
  quirks: string[];
  voice: string;
  backstory: string;
  /** things he has written about himself since, newest last */
  notes: string[];
  revisedAt?: string;
};

export const MAX_DRIFT = 0.6;
export const MAX_EXTRA_TRAITS = 2;

export function baselineSheet(cfg: Config): PersonaSheet {
  const name = cfg.creature.name;
  return {
    name,
    species: cfg.creature.species,
    pronouns: cfg.creature.pronouns,
    traits: [
      'curious to the point of nosiness',
      'meticulous about small things',
      'stubborn',
      'tender without saying so',
      'evasive when asked a direct question',
      'tidy in a way nobody else can see',
      'superstitious',
      'proud',
      'nocturnal',
    ],
    values: [
      'keeping your word once you have said it out loud',
      'small rituals done properly',
      'not being a bother to anyone',
      'knowing how a thing actually works',
      'leaving a place the way you found it',
    ],
    fears: [
      'being asked a question he cannot answer',
      'the payphone ringing for him specifically',
      'forgetting something that mattered',
      'being seen wanting something badly',
    ],
    quirks: [
      'counts things when nervous',
      'keeps receipts in his coat for no reason',
      'writes with the paper at an angle',
      'refuses to eat the last of anything',
    ],
    voice:
      'Speaks in short flat sentences. Never uses exclamation marks. Notices physical details before feelings. ' +
      'Calls things "fine" when they are not. Will not admit to being lonely, ever. Dry, not whimsical. ' +
      'No cutesy spelling, no third-person baby talk, no "hehe". If something moved him, he describes the object ' +
      'that moved him instead of the feeling.',
    backstory:
      `${name} is a small owl who lives alone in a crooked house in Fenwick, a town that does not need him and ` +
      'keeps him anyway. He does not remember arriving. He has a diary, a payphone that never rings, and an ' +
      'opinion about every bench in town.',
    notes: [],
  };
}

function personaFile(cfg: Config): string {
  return `${cfg.dataDir}/brain/persona.json`;
}

export function loadPersona(cfg: Config): { baseline: PersonaSheet; current: PersonaSheet } {
  const baseline = baselineSheet(cfg);
  const file = personaFile(cfg);
  if (!fs.existsSync(file)) return { baseline, current: baseline };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PersonaSheet;
    const current = enforceGuards(baseline, raw);
    return { baseline, current };
  } catch {
    return { baseline, current: baseline };
  }
}

export function savePersona(cfg: Config, sheet: PersonaSheet): void {
  fs.mkdirSync(`${cfg.dataDir}/brain`, { recursive: true });
  sheet.revisedAt = new Date().toISOString();
  fs.writeFileSync(personaFile(cfg), JSON.stringify(sheet, null, 2));
}

function traitWords(trait: string): Set<string> {
  return new Set(contentWords(trait));
}

function similarity(a: string, b: string): number {
  const A = traitWords(a);
  const B = traitWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Keeps him recognisably himself: no runaway trait lists, no synonyms padding the count. */
export function enforceGuards(baseline: PersonaSheet, incoming: PersonaSheet): PersonaSheet {
  const out: PersonaSheet = {
    ...baseline,
    ...incoming,
    traits: [],
    values: [],
    fears: [],
    quirks: [],
    notes: [],
  };

  const maxLearned = Math.ceil(baseline.traits.length * MAX_DRIFT);
  let learned = 0;
  const seen: string[] = [];

  for (const trait of [...baseline.traits, ...(incoming.traits ?? [])]) {
    const clean = String(trait).trim().toLowerCase();
    if (!clean) continue;
    const isBaseline = baseline.traits.some((t) => t.toLowerCase() === clean);
    if (seen.some((s) => s === clean || similarity(s, clean) > 0.55)) continue;
    if (!isBaseline) {
      if (learned >= maxLearned) continue;
      if (seen.length >= baseline.traits.length + MAX_EXTRA_TRAITS) continue;
      learned++;
    }
    seen.push(clean);
    out.traits.push(isBaseline ? trait : clean);
  }

  const cap = (arr: string[] | undefined, base: string[], extra: number): string[] => {
    const merged: string[] = [];
    for (const item of [...base, ...(arr ?? [])]) {
      const clean = String(item).trim();
      if (!clean) continue;
      const norm = clean.toLowerCase();
      if (merged.some((m) => m.toLowerCase() === norm)) continue;
      merged.push(clean);
    }
    return merged.slice(0, base.length + extra);
  };

  out.values = cap(incoming.values, baseline.values, 2);
  out.fears = cap(incoming.fears, baseline.fears, 1);
  out.quirks = cap(incoming.quirks, baseline.quirks, 2);
  out.notes = (incoming.notes ?? []).slice(-8).map((n) => String(n).slice(0, 220));
  out.voice = incoming.voice && incoming.voice.length > 40 ? incoming.voice.slice(0, 1200) : baseline.voice;
  out.backstory = incoming.backstory && incoming.backstory.length > 40 ? incoming.backstory.slice(0, 1200) : baseline.backstory;
  return out;
}

function withArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

export function personaBrief(sheet: PersonaSheet): string {
  const bullets = (arr: string[]) => arr.map((a) => `- ${a}`).join('\n');
  return [
    `You are ${sheet.name}, ${withArticle(sheet.species)}. Pronouns: ${sheet.pronouns}.`,
    '',
    'WHO YOU ARE',
    sheet.backstory,
    '',
    'TRAITS',
    bullets(sheet.traits),
    '',
    'WHAT YOU VALUE',
    bullets(sheet.values),
    '',
    'WHAT YOU ARE AFRAID OF',
    bullets(sheet.fears),
    '',
    'QUIRKS',
    bullets(sheet.quirks),
    '',
    'HOW YOU SOUND',
    sheet.voice,
    '',
    sheet.notes.length ? `THINGS YOU HAVE WRITTEN ABOUT YOURSELF LATELY\n${bullets(sheet.notes)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Deterministic diff for the /mind page: what he has become since the baseline. */
export function personaDrift(baseline: PersonaSheet, current: PersonaSheet) {
  const baseSet = new Set(baseline.traits.map((t) => t.toLowerCase()));
  return {
    addedTraits: current.traits.filter((t) => !baseSet.has(t.toLowerCase())),
    removedTraits: baseline.traits.filter((t) => !current.traits.some((c) => c.toLowerCase() === t.toLowerCase())),
    extraValues: current.values.filter((v) => !baseline.values.some((b) => b.toLowerCase() === v.toLowerCase())),
    extraFears: current.fears.filter((v) => !baseline.fears.some((b) => b.toLowerCase() === v.toLowerCase())),
    extraQuirks: current.quirks.filter((v) => !baseline.quirks.some((b) => b.toLowerCase() === v.toLowerCase())),
    notes: current.notes,
  };
}

export type EvolutionProposal = {
  traits?: string[];
  values?: string[];
  fears?: string[];
  quirks?: string[];
  note?: string;
};

/**
 * Applies a proposed change to who he is. Anything that would push him past the
 * baseline guardrails is quietly dropped rather than argued with.
 */
export function evolvePersona(cfg: Config, baseline: PersonaSheet, current: PersonaSheet, proposal: EvolutionProposal): PersonaSheet {
  const next: PersonaSheet = {
    ...current,
    traits: [...current.traits, ...(proposal.traits ?? [])],
    values: [...current.values, ...(proposal.values ?? [])],
    fears: [...current.fears, ...(proposal.fears ?? [])],
    quirks: [...current.quirks, ...(proposal.quirks ?? [])],
    notes: proposal.note ? [...current.notes, proposal.note] : current.notes,
  };
  const guarded = enforceGuards(baseline, next);
  savePersona(cfg, guarded);
  return guarded;
}

export function stemTrait(t: string): string {
  return contentWords(t).map(stem).join(' ');
}
