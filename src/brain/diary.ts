import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Brain } from './llm.ts';
import { truncate } from '../util/text.ts';

function logsDir(cfg: Config): string {
  const dir = path.join(cfg.dataDir, 'brain', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function diaryDir(cfg: Config): string {
  const dir = path.join(cfg.dataDir, 'brain', 'diary');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logPath(cfg: Config, day: number): string {
  return path.join(logsDir(cfg), `day-${String(day).padStart(4, '0')}.md`);
}

export function diaryPath(cfg: Config, day: number): string {
  return path.join(diaryDir(cfg), `day-${String(day).padStart(4, '0')}.md`);
}

export function appendLog(cfg: Config, day: number, line: string): void {
  const file = logPath(cfg, day);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# day ${day} — raw log\n\n`);
  }
  fs.appendFileSync(file, `${line}\n`);
}

export function readLog(cfg: Config, day: number): string {
  const file = logPath(cfg, day);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

export function hasDiary(cfg: Config, day: number): boolean {
  return fs.existsSync(diaryPath(cfg, day));
}

/** Diary entries are keyed by in-world day, oldest first. */
export function listDiary(cfg: Config): Array<{ day: number; body: string; file: string }> {
  const dir = diaryDir(cfg);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const day = Number(/day-(\d+)/.exec(f)?.[1] ?? 0);
      return { day, body: fs.readFileSync(path.join(dir, f), 'utf8'), file: f };
    })
    .sort((a, b) => b.day - a.day);
}

export function gc(cfg: Config, today: number): void {
  const dir = logsDir(cfg);
  for (const f of fs.readdirSync(dir)) {
    const m = /day-(\d+)/.exec(f);
    if (!m) continue;
    if (today - Number(m[1]) > cfg.memory.logRetentionDays) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* ignore */
      }
    }
  }
}

export async function writeDiaryEntry(args: {
  cfg: Config;
  brain: Brain;
  day: number;
  personaBrief: string;
  memoryDigest: string;
  logText: string;
  forced?: boolean;
}): Promise<{ ok: boolean; text: string; error?: string }> {
  const { cfg, brain, day, personaBrief: brief, memoryDigest, logText } = args;
  if (!logText.trim()) return { ok: false, text: '', error: 'nothing logged today' };

  const res = await brain.complete({
    system:
      `${brief}\n\nYou are alone, at the end of the day, writing your diary by lamplight. ` +
      'First person, past tense. This is the only place you are honest. Nobody will read it over your shoulder.',
    user: [
      `Day ${day} is nearly over in Fenwick.`,
      '',
      'Your raw log for today:',
      truncate(logText, 5000),
      '',
      'What you are carrying around in your head:',
      memoryDigest,
      '',
      'Write today\'s diary entry.',
      'Rules:',
      '- 120 to 220 words. Short sentences. No exclamation marks.',
      '- Only use things that actually happened in the log. Do not invent events, people or places.',
      '- Do not summarise the whole day in order. Pick the two or three things that stuck.',
      '- Notice objects and physical details rather than naming feelings.',
      '- Do not end with a moral or a lesson. End on an image, a small action, or a flat fact.',
      '- No headings, no title, no date. Just the entry.',
    ].join('\n'),
    model: 'quality',
    maxTokens: 600,
    temperature: 1.0,
  });

  if (!res.ok || !res.text.trim()) {
    return { ok: false, text: '', error: res.error ?? 'empty entry' };
  }
  const body = res.text.trim();
  const file = diaryPath(cfg, day);
  fs.writeFileSync(file, `# day ${day}\n\n${body}\n`);
  return { ok: true, text: body };
}
