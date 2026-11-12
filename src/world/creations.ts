import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { addEvent, type Creation, type WorldState } from './state.ts';

/**
 * What he has made, standing where he made it.
 *
 * A file in data/workshop is not a thing in his world until the town notices it.
 * This walks the workshop, registers anything new at the tile he was standing on,
 * and gives the brain something it can perceive and walk over to look at.
 */

const SKIP = new Set(['node_modules', '.git']);
const NOT_A_THING = /\.(tmp|part|lock)$/i;
/** a file that is still being written is not finished enough to stand in a town */
const SETTLE_MS = 1500;

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

/**
 * Register anything he has made since the last look. New files appear at his
 * feet, which is honest: he made them where he was standing. Returns only the
 * ones added this time, so a caller can react to a genuinely new thing.
 */
export function syncCreations(cfg: Config, state: WorldState): Creation[] {
  if (!cfg.workshop.enabled) return [];
  const root = workshopRoot(cfg);
  const files = walk(root);
  const known = new Set(state.creations.map((c) => c.file));
  const fresh: Creation[] = [];
  const tile = { x: Math.floor(state.creature.pos.x), y: Math.floor(state.creature.pos.y) };

  for (const file of files) {
    if (known.has(file)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(root, file)).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - mtime < SETTLE_MS) continue;
    const creation: Creation = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      file,
      name: creationName(file),
      tile,
      day: state.clock.day,
      at: Date.now(),
      lookedAt: null,
    };
    state.creations.push(creation);
    fresh.push(creation);
    addEvent(state, 'creation', `leaves "${creation.name}" standing where he made it`, 0.55);
  }

  // something gone from the workshop is not standing in the town any more
  const alive = state.creations.filter((c) => creationExists(cfg, c));
  if (alive.length !== state.creations.length) state.creations = alive;
  if (state.creations.length > 60) state.creations = state.creations.slice(-60);

  return fresh;
}
