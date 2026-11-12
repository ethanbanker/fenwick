import fs from 'node:fs';
import path from 'node:path';
import { isCreationKind, type CreationKind } from './util/creation-kinds.ts';

/**
 * The idea queue.
 *
 * He does not hand-write the thing he wants any more. He describes it: a title,
 * what it is, where it should stand, a few details. That description is written
 * down as a build brief for an outside builder (Freebuff, on the server, for
 * free) to execute. The only thing that comes back is the finished file in
 * data/workshop, and the town turns that into an object like any other.
 */

export type IdeaDraft = {
  title: string;
  slug: string;
  kind: CreationKind;
  /** one paragraph, the thing itself */
  idea: string;
  details: string[];
};

export type Idea = IdeaDraft & {
  id: string;
  /** file name inside data/workshop */
  target: string;
  /** where it will stand, reserved when the idea is made */
  tile: { x: number; y: number };
  want: string | null;
  place: string | null;
  day: number;
  time: string;
  createdAt: string;
};

export type IdeaStage = 'pending' | 'claimed' | 'done';

const MAX_TITLE = 90;
const MAX_IDEA = 900;

export function ideasDir(dataDir: string): string {
  return path.join(dataDir, 'ideas');
}

function stageDir(dataDir: string, stage: IdeaStage): string {
  const dir = path.join(ideasDir(dataDir), stage);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clean(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Turn whatever the model said into something safe to write down, or nothing. */
export function sanitizeDraft(raw: {
  title?: unknown;
  slug?: unknown;
  kind?: unknown;
  idea?: unknown;
  details?: unknown;
}): IdeaDraft | null {
  const title = clean(raw.title, MAX_TITLE);
  const idea = clean(raw.idea, MAX_IDEA);
  if (title.length < 3 || idea.length < 20) return null;
  if (!isCreationKind(raw.kind)) return null;
  const slug =
    clean(raw.slug ?? title, 60)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'thing';
  const details = Array.isArray(raw.details)
    ? raw.details.map((d) => clean(d, 200)).filter(Boolean).slice(0, 8)
    : [];
  return { title, slug, kind: raw.kind, idea, details };
}

export function buildBrief(idea: Idea): string {
  return [
    `# Build this: ${idea.title}`,
    '',
    `- kind: ${idea.kind}`,
    `- write the finished file to: data/workshop/${idea.target}`,
    `- it will stand at tile ${idea.tile.x},${idea.tile.y} in the town`,
    `- asked for by Mochi on day ${idea.day}, ${idea.time}${idea.place ? `, at ${idea.place}` : ''}`,
    idea.want ? `- he wanted: ${idea.want}` : '',
    '',
    '## The idea',
    idea.idea,
    '',
    idea.details.length ? '## Details he cares about' : '',
    ...idea.details.map((d) => `- ${d}`),
    '',
    '## Contract',
    `Write exactly one self-contained HTML file at data/workshop/${idea.target}. No external assets, no network calls, no build step. ` +
      'It is opened as a small object in a neon town, not as a homepage: it should read at a glance, weathered, a little shabby, made by hand.',
    'Nothing else needs to change. The town picks the file up on its own and places it at the reserved tile.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The brief as a self-contained instruction for the builder. */
export function exportText(idea: Idea): string {
  return [
    'You are building one object for a small neon town. Read the brief and create exactly the one file it asks for.',
    'Do not ask questions, do not write anything else, and do not change any other file.',
    '',
    buildBrief(idea),
  ].join('\n');
}

export function writeIdea(
  dataDir: string,
  draft: IdeaDraft,
  meta: { tile: { x: number; y: number }; want: string | null; place: string | null; day: number; time: string },
): Idea {
  const id = `idea-${meta.day}-${draft.slug}-${Math.random().toString(36).slice(2, 6)}`;
  const idea: Idea = {
    ...draft,
    id,
    target: `${draft.slug}.html`,
    tile: meta.tile,
    want: meta.want,
    place: meta.place,
    day: meta.day,
    time: meta.time,
    createdAt: new Date().toISOString(),
  };
  const dir = stageDir(dataDir, 'pending');
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(idea, null, 2));
  fs.writeFileSync(path.join(dir, `${id}.md`), `${buildBrief(idea)}\n`);
  return idea;
}

export function listIdeas(dataDir: string): Array<Idea & { stage: IdeaStage }> {
  const out: Array<Idea & { stage: IdeaStage }> = [];
  for (const stage of ['pending', 'claimed', 'done'] as IdeaStage[]) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(ideasDir(dataDir), stage)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const idea = JSON.parse(fs.readFileSync(path.join(ideasDir(dataDir), stage, file), 'utf8')) as Idea;
        if (idea?.id && idea?.target) out.push({ ...idea, stage });
      } catch {
        /* a half-written idea is not an idea */
      }
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function pendingIdeas(dataDir: string): Array<Idea & { stage: IdeaStage }> {
  return listIdeas(dataDir).filter((i) => i.stage === 'pending' || i.stage === 'claimed');
}

/** The reserved tile and purpose for a file, if an idea asked for it. */
export function ideaForFile(dataDir: string, target: string): Idea | null {
  return listIdeas(dataDir).find((i) => i.target === target) ?? null;
}

export function moveIdea(dataDir: string, id: string, to: IdeaStage): void {
  const from = listIdeas(dataDir).find((i) => i.id === id);
  if (!from) return;
  const dest = stageDir(dataDir, to);
  for (const suffix of ['json', 'md']) {
    const src = path.join(ideasDir(dataDir), from.stage, `${id}.${suffix}`);
    try {
      fs.renameSync(src, path.join(dest, `${id}.${suffix}`));
    } catch {
      /* the builder may have removed one already */
    }
  }
}
