import fs from 'node:fs';
import type { Config } from '../config.ts';

/**
 * The box. Everything else he knows fades: memory halves every few days and the
 * weakest lines get pushed out. What goes in here does not. It is a plain JSON
 * file in data/ on the machine, so it survives restarts and is his to keep.
 */

export type VaultEntry = { id: string; text: string; day: number; at: number };

export type Vault = {
  entries: VaultEntry[];
  count: () => number;
  keep: (text: string, day: number) => { ok: boolean; reason?: string; entry?: VaultEntry };
  digest: (limit?: number) => string;
};

/** Hard cap, so the box cannot become a second memory. */
const CAP = 80;

function pathFor(cfg: Config): string {
  return `${cfg.dataDir}/vault.json`;
}

export function loadVault(cfg: Config): Vault {
  let entries: VaultEntry[] = [];
  try {
    if (fs.existsSync(pathFor(cfg))) {
      const raw = JSON.parse(fs.readFileSync(pathFor(cfg), 'utf8')) as { entries?: VaultEntry[] };
      if (Array.isArray(raw?.entries)) {
        entries = raw.entries.filter((e) => e && typeof e.text === 'string' && e.text.trim().length > 0);
      }
    }
  } catch {
    entries = [];
  }

  const save = (): void => {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const tmp = `${pathFor(cfg)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
    fs.renameSync(tmp, pathFor(cfg));
  };

  return {
    entries,
    count: () => entries.length,
    keep: (text, day) => {
      const clean = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      if (clean.length < 4) return { ok: false, reason: 'too short to be worth keeping' };
      if (entries.some((e) => e.text.toLowerCase() === clean.toLowerCase())) {
        return { ok: false, reason: 'that is already in the box' };
      }
      if (entries.length >= CAP) {
        return { ok: false, reason: `the box is full (${CAP}); nothing more fits until something comes out` };
      }
      const entry: VaultEntry = {
        id: `v${Date.now().toString(36)}`,
        text: clean,
        day,
        at: Date.now(),
      };
      entries.push(entry);
      save();
      return { ok: true, entry };
    },
    digest: (limit = 10) => {
      if (!entries.length) return '(nothing yet)';
      return entries
        .slice(-limit)
        .map((e) => `- day ${e.day}: ${e.text}`)
        .join('\n');
    },
  };
}
