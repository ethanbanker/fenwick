import fs from 'node:fs';
import type { Config } from '../config.ts';
import type { Brain } from './llm.ts';
import type { PersonaSheet } from './persona.ts';
import { contentWords } from '../util/text.ts';

export type MemorySection = 'facts' | 'people' | 'places' | 'opinions' | 'self';

export const SECTIONS: MemorySection[] = ['facts', 'people', 'places', 'opinions', 'self'];

export type Bullet = {
  id: string;
  section: MemorySection;
  text: string;
  /** 0..1, halves every `halfLifeDays` unless reinforced */
  strength: number;
  updatedDay: number;
  createdDay: number;
  keys: string[];
  timesReinforced: number;
};

export type MemoryFile = {
  bullets: Bullet[];
  nextId: number;
  skills: string[];
  tools: string[];
  lastConsolidatedDay: number;
};

export type MemoryStore = {
  file: MemoryFile;
  effective: (b: Bullet, day: number) => number;
  sectionBullets: (section: MemorySection, day: number) => Bullet[];
  add: (section: MemorySection, text: string, opts?: { strength?: number; day?: number; source?: string }) => { ok: boolean; bullet?: Bullet; reason?: string };
  reinforce: (id: string, day: number, amount?: number) => void;
  revise: (id: string, text: string) => void;
  forget: (id: string) => void;
  decay: (day: number) => void;
  digest: (day: number, limit?: number) => string;
  counts: (day: number) => Record<MemorySection, number>;
  weakest: (section: MemorySection, day: number) => Bullet | null;
  save: () => void;
};

const SECTION_TITLES: Record<MemorySection, string> = {
  facts: 'Facts',
  people: 'People',
  places: 'Places',
  opinions: 'Opinions',
  self: 'Self',
};

function pathFor(cfg: Config): string {
  return `${cfg.dataDir}/brain/memory.json`;
}

function emptyFile(): MemoryFile {
  return { bullets: [], nextId: 1, skills: [], tools: [], lastConsolidatedDay: 0 };
}

export function loadMemory(cfg: Config): MemoryStore {
  let file: MemoryFile = emptyFile();
  try {
    if (fs.existsSync(pathFor(cfg))) {
      const raw = JSON.parse(fs.readFileSync(pathFor(cfg), 'utf8')) as MemoryFile;
      if (Array.isArray(raw.bullets)) file = { ...emptyFile(), ...raw };
    }
  } catch {
    file = emptyFile();
  }

  const effective = (b: Bullet, day: number): number => {
    const age = Math.max(0, day - b.updatedDay);
    return b.strength * Math.pow(0.5, age / cfg.memory.halfLifeDays);
  };

  const save = (): void => {
    fs.mkdirSync(`${cfg.dataDir}/brain`, { recursive: true });
    fs.writeFileSync(pathFor(cfg), JSON.stringify(file, null, 2));
    fs.writeFileSync(`${cfg.dataDir}/brain/memory.md`, renderMarkdown(file, cfg));
  };

  const sectionBullets = (section: MemorySection, day: number): Bullet[] =>
    file.bullets.filter((b) => b.section === section).sort((a, b) => effective(b, day) - effective(a, day));

  const keyCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const b of file.bullets) {
      for (const k of new Set(b.keys)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  };

  const pairCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const b of file.bullets) {
      const keys = [...new Set(b.keys)].sort();
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const pair = `${keys[i]}|${keys[j]}`;
          counts.set(pair, (counts.get(pair) ?? 0) + 1);
        }
      }
    }
    return counts;
  };

  const store: MemoryStore = {
    file,
    effective,
    sectionBullets,
    counts: (day) => {
      const out = {} as Record<MemorySection, number>;
      for (const s of SECTIONS) out[s] = sectionBullets(s, day).length;
      return out;
    },
    weakest: (section, day) => {
      const list = sectionBullets(section, day);
      return list.length ? list[list.length - 1] : null;
    },
    add: (section, text, opts = {}) => {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean.length < 3) return { ok: false, reason: 'too short' };
      const day = opts.day ?? 0;
      const keys = [...new Set(contentWords(clean))].slice(0, 12);

      // a subject may only own so many bullets, or he ends up with a fixation
      const kc = keyCounts();
      for (const k of keys) {
        if ((kc.get(k) ?? 0) >= cfg.memory.subjectCeiling) {
          return { ok: false, reason: `subject ceiling: "${k}" is already carrying too much` };
        }
      }
      const pc = pairCounts();
      const sorted = [...keys].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const pair = `${sorted[i]}|${sorted[j]}`;
          if ((pc.get(pair) ?? 0) >= cfg.memory.pairCeiling) {
            return { ok: false, reason: `idea ceiling: "${sorted[i]} ${sorted[j]}" again` };
          }
        }
      }

      // near-duplicates get folded into the existing line instead of added
      for (const existing of file.bullets) {
        const overlap = keys.filter((k) => existing.keys.includes(k)).length;
        if (keys.length && overlap / keys.length >= 0.75) {
          existing.strength = Math.min(1, existing.strength + 0.15);
          existing.timesReinforced += 1;
          existing.updatedDay = day;
          save();
          return { ok: true, bullet: existing, reason: 'reinforced existing memory' };
        }
      }

      const sameSection = sectionBullets(section, day);
      const strength = opts.strength ?? 0.6;
      if (sameSection.length >= cfg.memory.slotsPerSection) {
        const weakest = sameSection[sameSection.length - 1];
        if (effective(weakest, day) >= strength) {
          return { ok: false, reason: 'no room and it is not worth more than what is already in there' };
        }
        file.bullets = file.bullets.filter((b) => b.id !== weakest.id);
      }

      const bullet: Bullet = {
        id: `m${file.nextId++}`,
        section,
        text: clean.slice(0, 300),
        strength,
        updatedDay: day,
        createdDay: day,
        keys,
        timesReinforced: 0,
      };
      file.bullets.push(bullet);
      save();
      return { ok: true, bullet };
    },
    reinforce: (id, day, amount = 0.2) => {
      const b = file.bullets.find((x) => x.id === id);
      if (!b) return;
      b.strength = Math.min(1, b.strength + amount);
      b.timesReinforced += 1;
      b.updatedDay = day;
      save();
    },
    revise: (id, text) => {
      const b = file.bullets.find((x) => x.id === id);
      if (!b) return;
      b.text = text.replace(/\s+/g, ' ').trim().slice(0, 300);
      b.keys = [...new Set(contentWords(b.text))].slice(0, 12);
      b.strength = Math.min(1, b.strength + 0.1);
      b.timesReinforced += 1;
      save();
    },
    forget: (id) => {
      file.bullets = file.bullets.filter((b) => b.id !== id);
      save();
    },
    decay: (day) => {
      for (const b of file.bullets) {
        const age = Math.max(0, day - b.updatedDay);
        b.strength = b.strength * Math.pow(0.5, age / cfg.memory.halfLifeDays);
        b.updatedDay = day;
      }
      const before = file.bullets.length;
      file.bullets = file.bullets.filter((b) => b.strength >= 0.06);
      if (file.bullets.length !== before) save();
    },
    digest: (day, limit = 14) => {
      const lines: string[] = [];
      for (const s of SECTIONS) {
        const list = sectionBullets(s, day);
        if (!list.length) continue;
        lines.push(`${SECTION_TITLES[s]}:`);
        for (const b of list) {
          const pct = Math.round(effective(b, day) * 100);
          lines.push(`  [${b.id} ${pct}%] ${b.text}`);
        }
      }
      if (!lines.length) return '(nothing yet, this is all still new)';
      return lines.join('\n').slice(0, 1400 * (limit / 10));
    },
    save,
  };
  return store;
}

export function renderMarkdown(file: MemoryFile, cfg: Config): string {
  const lines: string[] = ['# memory', ''];
  for (const s of SECTIONS) {
    const list = file.bullets
      .filter((b) => b.section === s)
      .sort((a, b) => b.strength - a.strength);
    lines.push(`## ${SECTION_TITLES[s]} (${list.length}/${cfg.memory.slotsPerSection})`, '');
    if (!list.length) lines.push('_empty_', '');
    for (const b of list) {
      lines.push(`- (${Math.round(b.strength * 100)}%) ${b.text}`);
    }
    lines.push('');
  }
  if (file.skills.length) {
    lines.push('## skills', '');
    for (const s of file.skills) lines.push(`- ${s}`);
    lines.push('');
  }
  if (file.tools.length) {
    lines.push('## tools', '');
    for (const s of file.tools) lines.push(`- ${s}`);
    lines.push('');
  }
  return lines.join('\n');
}

export type ConsolidationResult = {
  revise: Array<{ id: string; text: string }>;
  forget: string[];
  add: Array<{ section: MemorySection; text: string; strength?: number }>;
  skills: string[];
  tools: string[];
  note?: string;
  evolution?: { traits?: string[]; values?: string[]; fears?: string[]; quirks?: string[] };
};

/** Sleep: read the day's log against what is already held, then rewrite rather than append. */
export async function consolidate(args: {
  cfg: Config;
  brain: Brain;
  memory: MemoryStore;
  persona: PersonaSheet;
  day: number;
  logText: string;
  personaBrief: string;
}): Promise<{ ok: boolean; applied: string[]; error?: string; result?: ConsolidationResult }> {
  const { cfg, brain, memory, day, logText, personaBrief: brief } = args;
  const current = memory.digest(day, 24);
  const res = await brain.json<ConsolidationResult>({
    system:
      `${brief}\n\nYou are asleep, consolidating the day. You are not talking to anyone. ` +
      'You are editing your own memory file. Be ruthless: a memory is for something that changed you or that you will need again. ' +
      'Routine (ate, walked, slept) is not memory unless something was odd about it.',
    user: [
      `It is the end of day ${day} in Fenwick.`,
      '',
      'WHAT YOU ALREADY REMEMBER (id, strength, text):',
      current,
      '',
      'WHAT HAPPENED TODAY (your log):',
      logText.slice(0, 6000),
      '',
      'Rewrite your memory. Rules:',
      `- At most 4 additions. Each section holds ${cfg.memory.slotsPerSection} lines and nothing is free.`,
      '- "revise" replaces an existing line with a sharper version of the same fact (keep the same id).',
      '- "forget" drops a line that no longer matters or that turned out to be wrong.',
      '- Do not add a line if something already in there says it.',
      '- Do not add two lines about the same subject.',
      '- "skills" are things you worked out how to do here. "tools" are things the town showed you it can do. Both optional.',
      '- "note" is one sentence about who you are becoming, if the day changed that at all.',
      '- "evolution" is only for a real change in character, not a mood. At most one trait, and only if this day proved it. Usually leave it out.',
      '',
      'Reply with JSON only, no prose:',
      '{"revise":[{"id":"m3","text":"..."}],"forget":["m7"],"add":[{"section":"opinions","text":"...","strength":0.7}],"skills":["..."],"tools":["..."],"note":"...","evolution":{"traits":["less afraid of being seen wanting something"]}}',
    ].join('\n'),
    model: 'quality',
    json: true,
    maxTokens: 1100,
    temperature: 0.7,
  });

  if (!res.ok || !res.data) {
    return { ok: false, applied: [], error: res.error ?? 'no consolidation produced' };
  }
  const result = res.data;
  const applied: string[] = [];
  for (const f of result.forget ?? []) {
    if (memory.file.bullets.some((b) => b.id === f)) {
      memory.forget(String(f));
      applied.push(`forgot ${f}`);
    }
  }
  for (const r of result.revise ?? []) {
    if (r?.id && r?.text && memory.file.bullets.some((b) => b.id === r.id)) {
      memory.revise(String(r.id), String(r.text));
      applied.push(`revised ${r.id}`);
    }
  }
  for (const a of result.add ?? []) {
    if (!a?.text || !SECTIONS.includes(a.section)) continue;
    const added = memory.add(String(a.section), String(a.text), {
      strength: typeof a.strength === 'number' ? Math.max(0.2, Math.min(1, a.strength)) : 0.6,
      day,
      source: 'sleep',
    });
    applied.push(added.ok ? `+ ${a.text.slice(0, 60)}` : `dropped (${added.reason})`);
  }
  for (const s of result.skills ?? []) {
    const clean = String(s).trim().slice(0, 200);
    if (clean && !memory.file.skills.includes(clean)) memory.file.skills.push(clean);
  }
  for (const t of result.tools ?? []) {
    const clean = String(t).trim().slice(0, 200);
    if (clean && !memory.file.tools.includes(clean)) memory.file.tools.push(clean);
  }
  if (memory.file.skills.length > 12) memory.file.skills = memory.file.skills.slice(-12);
  if (memory.file.tools.length > 12) memory.file.tools = memory.file.tools.slice(-12);
  memory.file.lastConsolidatedDay = day;
  memory.decay(day);
  memory.save();
  return { ok: true, applied, result };
}
