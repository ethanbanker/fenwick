import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Town } from './map.ts';
import { addEvent, type WorldState } from './state.ts';
import { pickCreationTile, workshopRoot } from './creations.ts';
import { moveIdea, pendingIdeas, writeIdea, type Idea, type IdeaDraft } from '../ideas.ts';

/** Book the spot before the object exists, so it lands where he meant it to. */
export function reserveIdea(cfg: Config, state: WorldState, town: Town, draft: IdeaDraft): Idea {
  const tile = pickCreationTile(state, town);
  const place = town.places.find((p) => p.id === state.creature.atPlace)?.name.replace(/^The\s+/i, 'the ') ?? null;
  const idea = writeIdea(cfg.dataDir, draft, {
    tile,
    want: state.project?.text ?? null,
    place,
    day: state.clock.day,
    time: `${String(Math.floor(state.clock.minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(state.clock.minutes % 60)).padStart(2, '0')}`,
  });
  addEvent(state, 'creation', `wants ${idea.title.toLowerCase()} built and put at the ${place ?? 'street'}`, 0.7);
  return idea;
}

/** Once the builder has written the file, the request is done — not before. */
export function reconcileIdeas(cfg: Config, state: WorldState): string[] {
  const root = workshopRoot(cfg);
  const built: string[] = [];
  for (const idea of pendingIdeas(cfg.dataDir)) {
    if (!fs.existsSync(path.join(root, idea.target))) continue;
    moveIdea(cfg.dataDir, idea.id, 'done');
    addEvent(state, 'creation', `the thing he asked for is standing there: ${idea.title}`, 0.75);
    built.push(idea.target);
  }
  return built;
}
