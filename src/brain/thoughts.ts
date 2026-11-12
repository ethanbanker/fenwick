import fs from 'node:fs';
import type { Config } from '../config.ts';

/**
 * A running record of what goes through his head, one JSON line per decision.
 * Append-only and cheap: it never goes through the model, it is just what he
 * already produced, written down where it can be read back in order.
 */

export type Thought = {
  at: number;
  day: number;
  time: string;
  /** the action he took, or "said" for a reply */
  action: string;
  thought: string;
  reason: string;
  tier: string;
  /** size of the prompt that produced it, so the cost is visible, not guessed */
  chars?: number;
};

const MAX_BYTES = 1_500_000;

function pathFor(cfg: Config): string {
  return `${cfg.dataDir}/brain/thoughts.jsonl`;
}

export function appendThought(cfg: Config, entry: Thought): void {
  try {
    fs.mkdirSync(`${cfg.dataDir}/brain`, { recursive: true });
    const file = pathFor(cfg);
    // keep the file bounded without needing a log rotation daemon
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-6000);
      fs.writeFileSync(file, `${kept.join('\n')}\n`);
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* a lost thought is not worth crashing the brain over */
  }
}

/** Newest first. */
export function readThoughts(cfg: Config, limit = 200): Thought[] {
  const want = Math.max(1, Math.min(limit, 1000));
  try {
    const lines = fs.readFileSync(pathFor(cfg), 'utf8').split('\n').filter(Boolean);
    const out: Thought[] = [];
    for (const line of lines.slice(-want)) {
      try {
        out.push(JSON.parse(line) as Thought);
      } catch {
        /* skip a half-written line */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}
