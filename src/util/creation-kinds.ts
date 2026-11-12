import fs from 'node:fs';
import path from 'node:path';

/**
 * What a thing he made actually is.
 *
 * He cannot invent an effect any more than he can invent an action, so the
 * workshop takes a short closed list of purposes: a lamp, a shelter, a seat, a
 * sign, a garden, or something that is only worth looking at. The world reads
 * that word and gives the thing a use; nothing else about the file matters.
 */

export type CreationKind = 'light' | 'shelter' | 'seat' | 'sign' | 'garden' | 'ornament';

export const CREATION_KINDS: CreationKind[] = ['light', 'shelter', 'seat', 'sign', 'garden', 'ornament'];

const LABELS: Record<CreationKind, string> = {
  light: 'a lamp',
  shelter: 'a shelter',
  seat: 'a seat',
  sign: 'a sign',
  garden: 'a garden',
  ornament: 'something to look at',
};

export function kindLabel(kind: CreationKind): string {
  return LABELS[kind];
}

export function isCreationKind(value: unknown): value is CreationKind {
  return typeof value === 'string' && (CREATION_KINDS as string[]).includes(value);
}

/** When he does not say what a thing is, its name and words usually give it away. */
const WORD_HINTS: Array<[CreationKind, RegExp]> = [
  ['light', /\b(lamp|lamps|lantern|lanterns|light|lights|bulb|bulbs|glow|candle|candles|neon|beacon)\b/i],
  ['shelter', /\b(shelter|shelters|hut|huts|house|roof|tent|bed|shed|den|awning|cover)\b/i],
  ['seat', /\b(seat|seats|bench|benches|chair|chairs|stool|stools|sofa|couch)\b/i],
  ['sign', /\b(sign|signs|notice|board|poster|placard|menu|label)\b/i],
  // word boundaries matter: "garden" contains "den" and is not a shelter
  ['garden', /\b(garden|gardens|plant|plants|seed|seeds|sprout|sprouts|herbs?|tree|trees|flowers?|vine|vines|tomatoes?|vegetables?)\b/i],
];

export function inferKind(name: string, preview = ''): CreationKind {
  const text = `${name} ${preview}`;
  for (const [kind, pattern] of WORD_HINTS) if (pattern.test(text)) return kind;
  return 'ornament';
}

/** The workshop runs in the brain process and the town in the world process; this is the handover. */
export function kindHintsFile(dataDir: string): string {
  return path.join(dataDir, 'creation-kinds.json');
}

export function readKindHints(dataDir: string): Record<string, CreationKind> {
  try {
    const raw = JSON.parse(fs.readFileSync(kindHintsFile(dataDir), 'utf8')) as Record<string, unknown>;
    const out: Record<string, CreationKind> = {};
    for (const [file, kind] of Object.entries(raw)) if (isCreationKind(kind)) out[file] = kind;
    return out;
  } catch {
    return {};
  }
}

export function rememberKind(dataDir: string, file: string, kind: CreationKind): void {
  const hints = readKindHints(dataDir);
  hints[file] = kind;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(kindHintsFile(dataDir), JSON.stringify(hints, null, 2));
  } catch {
    /* the town can still guess from the name */
  }
}

/** How he would describe the state of it, in his own terms. */
export function conditionWord(condition: number): string {
  if (condition <= 0) return 'fallen over';
  if (condition < 0.3) return 'falling apart';
  if (condition < 0.6) return 'looking worn';
  return 'holding up';
}
