import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Point } from '../util/geo.ts';
import { inferKind, readKindHints, rememberKind, type CreationKind } from '../util/creation-kinds.ts';
import { ideaForFile } from '../ideas.ts';
import { addEvent, hoursElapsed, type Creation, type WorldState } from './state.ts';
import { T, type Town } from './map.ts';

/**
 * What he has made, standing where he made it.
 *
 * A file in data/workshop is not a thing in his world until the town notices it.
 * This walks the workshop, registers anything new at the tile he was standing
 * on, gives it the purpose he declared (or guesses it from the name), and lets
 * it grow or come apart while he gets on with his life.
 */

const SKIP = new Set(['node_modules', '.git']);
const NOT_A_THING = /\.(tmp|part|lock)$/i;
/** a file that is still being written is not finished enough to stand in a town */
const SETTLE_MS = 1500;
/** about ten in-world days of being ignored before it is lying on its side */
const DECAY_PER_HOUR = 1 / (10 * 24);

function walk(root: string, rel = '', out: string[] = [], depth = 0): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || NOT_A_THING.test(e.name)) continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth >= 3 || SKIP.has(e.name)) continue;
      walk(root, next, out, depth + 1);
    } else if (e.isFile()) {
      out.push(next);
    }
  }
  return out;
}

export function workshopRoot(cfg: Config): string {
  return path.join(cfg.dataDir, 'workshop');
}

/** A file name, made into something he could say out loud. */
export function creationName(file: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const words = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (words || 'something').slice(0, 40);
}

const PICTURE = /\.(png|jpe?g|webp|gif|svg)$/i;

/** The first readable line of it, so he can recognise his own work. */
export function creationPreview(cfg: Config, file: string, max = 160): string {
  if (PICTURE.test(file)) return 'a picture';
  try {
    const raw = fs.readFileSync(path.join(workshopRoot(cfg), file), 'utf8');
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  } catch {
    return '';
  }
}

export function creationExists(cfg: Config, c: Creation): boolean {
  try {
    return fs.statSync(path.join(workshopRoot(cfg), c.file)).isFile();
  } catch {
    return false;
  }
}

/** A garden he planted gets taller while he leaves it alone. */
export function creationStage(state: WorldState, made: Creation): number {
  if (made.kind !== 'garden') return 0;
  const age = Math.max(0, state.clock.day - made.day);
  return Math.min(2, Math.floor(age / 2));
}

/**
 * Register anything he has made since the last look. New files appear at his
 * feet, which is honest: he made them where he was standing. Returns only the
 * ones added this time, so a caller can react to a genuinely new thing.
 */
/**
 * A free tile beside him for a new thing, so a morning of building becomes a
 * corner of town instead of a single pile at his feet.
 */
export function pickCreationTile(state: WorldState, town: Town | null): Point {
  const base = { x: Math.floor(state.creature.pos.x), y: Math.floor(state.creature.pos.y) };
  const taken = new Set(state.creations.map((c) => `${c.tile.x},${c.tile.y}`));
  const walkable = (x: number, y: number): boolean => {
    if (!town) return true;
    if (x < 0 || y < 0 || x >= town.w || y >= town.h) return false;
    const t = town.tiles[y * town.w + x];
    return t !== T.building && t !== T.water && t !== T.tree;
  };
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = base.x + dx;
        const y = base.y + dy;
        if (!walkable(x, y) || taken.has(`${x},${y}`)) continue;
        return { x, y };
      }
    }
  }
  return base;
}

export function syncCreations(cfg: Config, state: WorldState, town: Town | null = null): Creation[] {
  if (!cfg.workshop.enabled) return [];
  const root = workshopRoot(cfg);
  const files = walk(root);
  const known = new Set(state.creations.map((c) => c.file));
  const hints = readKindHints(cfg.dataDir);
  const fresh: Creation[] = [];

  for (const file of files) {
    if (known.has(file)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(root, file)).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - mtime < SETTLE_MS) continue;
    const planned = ideaForFile(cfg.dataDir, file);
    const name = creationName(file);
    const kind = planned?.kind ?? hints[file] ?? inferKind(name, creationPreview(cfg, file, 200));
    // an idea booked its spot before the builder ever wrote the file
    const tile = planned ? planned.tile : pickCreationTile(state, town);
    if (planned) rememberKind(cfg.dataDir, file, planned.kind);
    const creation: Creation = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      file,
      name,
      tile,
      day: state.clock.day,
      at: Date.now(),
      lookedAt: null,
      kind,
      condition: 1,
      used: 0,
      mendedDay: null,
    };
    state.creations.push(creation);
    fresh.push(creation);
    addEvent(state, 'creation', `leaves "${creation.name}" standing where he made it`, 0.55);
    if (state.project && state.project.kind === creation.kind) {
      addEvent(state, 'creation', `finishes what he set out to make: ${state.project.text}`, 0.65);
      state.project = null;
    }
  }

  // something gone from the workshop is not standing in the town any more
  const alive = state.creations.filter((c) => creationExists(cfg, c));
  if (alive.length !== state.creations.length) state.creations = alive;
  if (state.creations.length > 60) state.creations = state.creations.slice(-60);

  return fresh;
}

/** The workshop writes the purpose down; the town picks it up here. */
export function applyKindHints(cfg: Config, state: WorldState): void {
  const hints = readKindHints(cfg.dataDir);
  for (const made of state.creations) {
    const hinted = hints[made.file];
    if (hinted && hinted !== made.kind) made.kind = hinted;
  }
}

/** Things left alone come apart. A garden does it more slowly than a lamp. */
export function decayCreations(cfg: Config, state: WorldState, dtSeconds: number): void {
  const hours = hoursElapsed(cfg, dtSeconds);
  if (hours <= 0) return;
  for (const made of state.creations) {
    if (made.condition <= 0) continue;
    const rate = made.kind === 'garden' ? DECAY_PER_HOUR * 0.6 : DECAY_PER_HOUR;
    const before = made.condition;
    made.condition = Math.max(0, made.condition - rate * hours);
    if (before > 0 && made.condition === 0) {
      addEvent(
        state,
        'creation',
        made.kind === 'light'
          ? `the lamp he hung at "${made.name}" has gone out for good`
          : `"${made.name}", which he made on day ${made.day}, has come apart where it stood`,
        0.55,
      );
    }
  }
}

/** The closest thing of a kind still standing, within reach of where he is. */
export function fixtureNear(
  state: WorldState,
  pos: Point,
  kind: CreationKind,
  radius: number,
  minCondition = 0.15,
): Creation | null {
  let best: Creation | null = null;
  let bestD = radius;
  for (const made of state.creations) {
    if (made.kind !== kind || made.condition <= minCondition) continue;
    const d = Math.hypot(made.tile.x + 0.5 - pos.x, made.tile.y + 0.5 - pos.y);
    if (d <= bestD) {
      bestD = d;
      best = made;
    }
  }
  return best;
}

/** A lamp he made, after dark, close enough to change how the street feels. */
export function nearLight(state: WorldState, pos: Point, radius = 2.6): Creation | null {
  return fixtureNear(state, pos, 'light', radius);
}

/** Somewhere he built to get out of the weather. */
export function nearShelter(state: WorldState, pos: Point, radius = 1.8): Creation | null {
  return fixtureNear(state, pos, 'shelter', radius);
}
