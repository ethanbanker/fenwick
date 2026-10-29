import type { Config } from '../config.ts';
import type { Point } from '../util/geo.ts';
import { findPath } from '../util/geo.ts';
import { clamp } from '../util/text.ts';
import { addEvent, isNight, msForWorldMinutes, type WorldState } from './state.ts';
import type { Town } from './map.ts';
import { applyMoodDelta, applyNeedDelta, needUrgency } from './needs.ts';
import { T } from './map.ts';

export type ActionContext = { cfg: Config; state: WorldState; town: Town; now: number };

export type Pull = { need: 'hunger' | 'fatigue' | 'curiosity' | 'unease'; weight: number };

export type ActionSpec = {
  id: string;
  /** plain-language label used in the HUD */
  label: string;
  /** where it can be done; empty means anywhere */
  places: string[];
  durationMinutes: [number, number];
  cooldownSeconds: number;
  pullFrom: Pull[];
  tags: string[];
  /** a line the creature could say about why he does it */
  appetite: string;
};

export const ACTIONS: ActionSpec[] = [
  {
    id: 'go_to',
    label: 'walk somewhere',
    places: [],
    durationMinutes: [0, 0],
    cooldownSeconds: 0,
    pullFrom: [
      { need: 'curiosity', weight: 0.35 },
      { need: 'hunger', weight: 0.2 },
    ],
    tags: ['travel'],
    appetite: 'somewhere else is probably better than here',
  },
  {
    id: 'forage',
    label: 'forage',
    places: ['park', 'ruins', 'pond'],
    durationMinutes: [30, 55],
    cooldownSeconds: 20,
    pullFrom: [{ need: 'hunger', weight: 1.0 }],
    tags: ['food', 'outside'],
    appetite: 'there is usually something edible under something else',
  },
  {
    id: 'eat',
    label: 'eat',
    places: ['bakery', 'market', 'nest'],
    durationMinutes: [20, 35],
    cooldownSeconds: 60,
    pullFrom: [{ need: 'hunger', weight: 1.2 }],
    tags: ['food', 'comfort'],
    appetite: 'his body has opinions about this',
  },
  {
    id: 'drink',
    label: 'drink',
    places: ['bar'],
    durationMinutes: [25, 45],
    cooldownSeconds: 90,
    pullFrom: [
      { need: 'unease', weight: 0.5 },
      { need: 'curiosity', weight: 0.3 },
    ],
    tags: ['comfort', 'social', 'night'],
    appetite: 'the bar is warm and loud and nobody asks him anything',
  },
  {
    id: 'dance',
    label: 'dance badly',
    places: ['bar'],
    durationMinutes: [20, 40],
    cooldownSeconds: 120,
    pullFrom: [{ need: 'curiosity', weight: 0.5 }],
    tags: ['joy', 'night', 'social'],
    appetite: 'the song has a bit that goes up and he likes that bit',
  },
  {
    id: 'read',
    label: 'read',
    places: ['library'],
    durationMinutes: [45, 80],
    cooldownSeconds: 30,
    pullFrom: [
      { need: 'curiosity', weight: 1.0 },
      { need: 'unease', weight: 0.3 },
    ],
    tags: ['quiet', 'learning'],
    appetite: 'somebody wrote a whole book about one thing and he wants to know why',
  },
  {
    id: 'groom',
    label: 'get groomed',
    places: ['salon'],
    durationMinutes: [30, 50],
    cooldownSeconds: 300,
    pullFrom: [{ need: 'unease', weight: 0.6 }],
    tags: ['comfort', 'vanity'],
    appetite: 'he has been looking slightly like a damp mop for days',
  },
  {
    id: 'launder',
    label: 'watch the washing',
    places: ['laundrette'],
    durationMinutes: [50, 80],
    cooldownSeconds: 120,
    pullFrom: [
      { need: 'unease', weight: 0.7 },
      { need: 'curiosity', weight: 0.2 },
    ],
    tags: ['quiet', 'ritual'],
    appetite: 'the drums go round and it is easy to think in there',
  },
  {
    id: 'doze',
    label: 'doze off',
    places: ['laundrette', 'plaza', 'park', 'nest', 'library', 'tower'],
    durationMinutes: [40, 70],
    cooldownSeconds: 60,
    pullFrom: [{ need: 'fatigue', weight: 0.8 }],
    tags: ['rest'],
    appetite: 'his eyes keep closing on their own',
  },
  {
    id: 'sleep',
    label: 'sleep properly',
    places: ['nest', 'park', 'tower'],
    durationMinutes: [200, 300],
    cooldownSeconds: 60,
    pullFrom: [{ need: 'fatigue', weight: 1.3 }],
    tags: ['rest', 'dream'],
    appetite: 'it is time to be unconscious for a while',
  },
  {
    id: 'browse',
    label: 'go on the internet',
    places: ['nest', 'library', 'laundrette'],
    durationMinutes: [60, 100],
    cooldownSeconds: 180,
    pullFrom: [
      { need: 'curiosity', weight: 1.0 },
      { need: 'fatigue', weight: -0.2 },
    ],
    tags: ['learning', 'quiet'],
    appetite: 'there is a whole internet and he has not checked it today',
  },
  {
    id: 'stargaze',
    label: 'look at the sky',
    places: ['tower', 'pond', 'park', 'ruins'],
    durationMinutes: [35, 60],
    cooldownSeconds: 120,
    pullFrom: [
      { need: 'unease', weight: 0.6 },
      { need: 'curiosity', weight: 0.3 },
    ],
    tags: ['night', 'quiet', 'outside'],
    appetite: 'the sky is doing something and he would like to see it',
  },
  {
    id: 'call',
    label: 'use the payphone',
    places: ['plaza'],
    durationMinutes: [10, 20],
    cooldownSeconds: 600,
    pullFrom: [{ need: 'curiosity', weight: 0.45 }],
    tags: ['odd', 'ritual'],
    appetite: 'it never rings, and that is exactly the problem',
  },
  {
    id: 'sit',
    label: 'sit still',
    places: ['plaza', 'laundrette', 'park', 'pond', 'ruins'],
    durationMinutes: [30, 55],
    cooldownSeconds: 30,
    pullFrom: [{ need: 'unease', weight: 0.45 }],
    tags: ['quiet'],
    appetite: 'the world can get on with it without him for a minute',
  },
  {
    id: 'write_diary',
    label: 'write in his diary',
    places: ['nest', 'library', 'laundrette'],
    durationMinutes: [30, 50],
    cooldownSeconds: 45,
    pullFrom: [{ need: 'unease', weight: 0.5 }],
    tags: ['diary', 'private'],
    appetite: 'the day is getting heavy and needs putting down somewhere',
  },
  {
    id: 'inspect',
    label: 'inspect something',
    places: [],
    durationMinutes: [8, 14],
    cooldownSeconds: 0,
    pullFrom: [{ need: 'curiosity', weight: 0.9 }],
    tags: ['offering', 'attention'],
    appetite: 'something is new and does not belong to him yet',
  },
  {
    id: 'wander',
    label: 'wander',
    places: [],
    durationMinutes: [35, 60],
    cooldownSeconds: 0,
    pullFrom: [{ need: 'curiosity', weight: 0.5 }],
    tags: ['travel'],
    appetite: 'legs first, then decide',
  },
];

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function getSpec(id: string): ActionSpec | undefined {
  return BY_ID.get(id);
}

/** Which place he is standing in, if any. */
export function placeOf(town: Town, pos: Point): string | null {
  for (const p of town.places) {
    if (p.kind === 'area') {
      if (
        pos.x >= p.rect.x - 0.6 &&
        pos.x <= p.rect.x + p.rect.w + 0.6 &&
        pos.y >= p.rect.y - 0.6 &&
        pos.y <= p.rect.y + p.rect.h + 0.6
      ) {
        return p.id;
      }
    }
  }
  let best: string | null = null;
  let bestD = 1.9;
  for (const p of town.places) {
    if (p.kind === 'area') continue;
    const d = Math.hypot(p.door.x + 0.5 - pos.x, p.door.y + 0.5 - pos.y);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

function placeName(town: Town, id: string): string {
  return town.places.find((p) => p.id === id)?.name ?? id;
}

/** "the Crooked House", "the Wet Feather" — never "the The". */
export function placePhrase(name: string): string {
  const lowered = name.replace(/^The\s+/i, 'the ');
  return /^the\s/i.test(lowered) ? lowered : `the ${lowered}`;
}

function tileOf(town: Town, placeId: string): Point {
  const p = town.places.find((x) => x.id === placeId);
  if (!p) return town.spawn;
  return { x: p.door.x + 0.5, y: p.door.y + 0.5 };
}

export type AvailableAction = {
  id: string;
  description: string;
  args: Record<string, unknown>;
  pull: number;
  /** only present when the action is close to the body already */
  here: boolean;
};

/** Everything he could plausibly do right now, cheapest to present to the model. */
export function availableActions(ctx: ActionContext): AvailableAction[] {
  const { state, town } = ctx;
  const c = state.creature;
  const here = placeOf(town, c.pos);
  const out: AvailableAction[] = [];

  // travel options: places worth walking to
  for (const p of town.places) {
    if (p.id === here) continue;
    const d = Math.hypot(p.door.x + 0.5 - c.pos.x, p.door.y + 0.5 - c.pos.y);
    if (d < 1.6) continue;
    const reasons = ACTIONS.filter((a) => a.places.includes(p.id));
    let pull = 0.04;
    for (const a of reasons) for (const pf of a.pullFrom) pull += needUrgency(state, pf.need) * pf.weight * 0.5;
    pull += clamp(d / 60, 0, 0.1);
    pull -= (state.visitedToday[p.id] ?? 0) * 0.08;
    out.push({
      id: 'go_to',
      description: `walk to ${placePhrase(p.name)}`,
      args: { place: p.id },
      pull: clamp(pull, 0, 1),
      here: false,
    });
  }

  for (const spec of ACTIONS) {
    if (spec.id === 'go_to' || spec.id === 'inspect') continue;
    if (spec.places.length && (!here || !spec.places.includes(here))) continue;
    if (spec.id === 'stargaze' && !isNight(state)) continue;
    if (spec.id === 'eat' && c.needs.hunger < 0.12) continue;
    if (spec.id === 'drink' && c.inventory.coins < 1) continue;
    if (spec.id === 'groom' && c.inventory.coins < 1) continue;
    if (spec.id === 'eat' && here === 'nest' && c.inventory.food < 1) continue;
    const cd = c.cooldowns[spec.id] ?? 0;
    if (cd > ctx.now) continue;
    if (spec.id === 'sleep' && state.creature.asleep) continue;
    let pull = 0.05;
    for (const pf of spec.pullFrom) {
      pull += needUrgency(state, pf.need, 0.45) * pf.weight;
      pull += needUrgency(state, pf.need, 0.8) * pf.weight * 0.6;
    }
    if (spec.id === 'browse' && state.weather.kind === 'rain') pull += 0.08;
    out.push({
      id: spec.id,
      description: `${spec.label}${here ? ` at ${placePhrase(placeName(town, here))}` : ''}`,
      args: {},
      pull: clamp(pull, 0, 1),
      here: true,
    });
  }

  // offerings close enough to notice
  for (const off of state.offerings) {
    if (off.state === 'kept' || off.state === 'released') continue;
    const d = Math.hypot(off.tile.x - c.pos.x, off.tile.y - c.pos.y);
    if (d <= ctx.cfg.offerings.senseRadiusTiles + 1.4) {
      out.push({
        id: 'inspect',
        description: `inspect the crystal left by ${off.from}`,
        args: { offering: off.id },
        pull: clamp(0.75 + needUrgency(state, 'curiosity', 0.3) * 0.3, 0, 1),
        here: true,
      });
    }
  }

  return out;
}

export function describeAction(town: Town, id: string, args: Record<string, unknown>): string {
  if (id === 'go_to') return `walk to ${placePhrase(placeName(town, String(args.place)))}`;
  if (id === 'inspect') return 'inspect a crystal';
  return getSpec(id)?.label ?? id;
}

export type StartResult = { ok: true; action: NonNullable<WorldState['creature']['action']> } | { ok: false; error: string };

export function startAction(ctx: ActionContext, id: string, args: Record<string, unknown>, reason: string, thought: string): StartResult {
  const { state, town, cfg, now } = ctx;
  const c = state.creature;
  const spec = getSpec(id);
  if (!spec) return { ok: false, error: `unknown action "${id}"` };
  if (c.action) return { ok: false, error: 'already in the middle of something' };

  const here = placeOf(town, c.pos);

  if (id === 'go_to') {
    const placeId = String(args.place ?? '');
    const place = town.places.find((p) => p.id === placeId);
    if (!place) return { ok: false, error: `there is no ${placeId} in this town` };
    const target = tileOf(town, placeId);
    const path = findPath(c.pos, target, (x, y) => {
      const t = town.tiles[y * town.w + x];
      return t !== T.building && t !== T.water && t !== T.tree;
    }, town.w, town.h);
    if (!path.length) return { ok: false, error: `cannot find a way to the ${place.name}` };
    c.path = path;
    const action = {
      id,
      label: `walking to ${placePhrase(place.name)}`,
      reason,
      thought,
      args,
      startedAt: now,
      endsAt: now + (path.length / c.speed) * 1000 + 400,
      phase: 'moving' as const,
    };
    c.action = action;
    addEvent(state, 'move', `sets off towards ${placePhrase(place.name)}`, 0.15);
    return { ok: true, action };
  }

  if (id === 'inspect') {
    const off = state.offerings.find((o) => o.id === String(args.offering));
    if (!off) return { ok: false, error: 'that crystal is not there any more' };
    if (off.state === 'kept' || off.state === 'released') return { ok: false, error: 'he already dealt with that one' };
    const d = Math.hypot(off.tile.x - c.pos.x, off.tile.y - c.pos.y);
    if (d > cfg.offerings.senseRadiusTiles + 1.4) return { ok: false, error: 'it is too far away to inspect' };
    off.state = 'found';
    const action = {
      id,
      label: `looking at what ${off.from} left`,
      reason,
      thought,
      args,
      startedAt: now,
      endsAt: now + msForWorldMinutes(cfg, 10),
      phase: 'doing' as const,
    };
    c.action = action;
    addEvent(state, 'offering', `finds a crystal from ${off.from} and crouches to look at it`, 0.8);
    return { ok: true, action };
  }

  // place-bound actions
  if (spec.places.length && (!here || !spec.places.includes(here))) {
    return { ok: false, error: `you cannot ${spec.label} here` };
  }
  if (id === 'stargaze' && !isNight(state)) return { ok: false, error: 'it is not night' };
  if (id === 'eat') {
    if (c.needs.hunger < 0.1) return { ok: false, error: 'he is not hungry at all' };
    if (here === 'nest' && c.inventory.food < 1) return { ok: false, error: 'nothing to eat at home' };
    if (here !== 'nest' && c.inventory.coins < 1 && c.inventory.food < 1) return { ok: false, error: 'no coins and no food' };
  }
  if ((id === 'drink' || id === 'groom') && c.inventory.coins < 1) {
    return { ok: false, error: 'no coins' };
  }
  const cd = c.cooldowns[id] ?? 0;
  if (cd > now) return { ok: false, error: 'he just did that, give it a minute' };

  const [lo, hi] = spec.durationMinutes;
  const minutes = lo + Math.random() * Math.max(0, hi - lo);
  const action = {
    id,
    label: `${spec.label}${here ? ` at ${placePhrase(placeName(town, here))}` : ''}`,
    reason,
    thought,
    args: { ...args, place: here ?? undefined },
    startedAt: now,
    endsAt: now + msForWorldMinutes(cfg, minutes),
    phase: 'doing' as const,
  };
  c.action = action;
  if (id === 'sleep') {
    c.asleep = true;
    addEvent(state, 'sleep', 'curls up and goes out like a lamp', 0.5);
  } else {
    addEvent(state, 'act', `starts to ${spec.label}${here ? ` at ${placePhrase(placeName(town, here))}` : ''}`, 0.3);
  }
  return { ok: true, action };
}

const PAYPHONE_LINES = [
  'a recording of a woman reading out bus times, three years out of date',
  'two rings, then somebody breathing, then the dial tone',
  'a wrong number who apologises and calls him "sir"',
  'nothing at all, which is somehow worse',
  'a man asking whether this is the plumber, and then not believing him',
];

/** Called when a timed action reaches its end. Returns extra signals for the brain. */
export function completeAction(ctx: ActionContext): { id: string; args: Record<string, unknown>; finishedAt: number } | null {
  const { state, town, cfg, now } = ctx;
  const c = state.creature;
  const action = c.action;
  if (!action) return null;
  const id = action.id;
  const place = placeOf(town, c.pos);
  c.action = null;

  if (id === 'go_to') {
    const target = String(action.args.place ?? '');
    state.visitedToday[target] = (state.visitedToday[target] ?? 0) + 1;
    state.actionsToday.go_to = (state.actionsToday.go_to ?? 0) + 1;
    state.actionHistory.push('go_to');
    if (state.actionHistory.length > 40) state.actionHistory.shift();
    const name = placeName(town, target);
    addEvent(state, 'arrive', `arrives at ${placePhrase(name)}`, 0.25);
    c.atPlace = placeOf(town, c.pos);
    return { id, args: action.args, finishedAt: now };
  }

  if (id === 'inspect') {
    return { id, args: action.args, finishedAt: now };
  }

  c.cooldowns[id] = now + getSpec(id)!.cooldownSeconds * 1000;
  state.actionsToday[id] = (state.actionsToday[id] ?? 0) + 1;
  state.actionHistory.push(id);
  if (state.actionHistory.length > 40) state.actionHistory.shift();

  switch (id) {
    case 'forage': {
      const roll = Math.random();
      applyNeedDelta(state, { hunger: -0.1 }, 1);
      if (roll < 0.5) {
        c.inventory.food += 1;
        addEvent(state, 'food', 'turns something over and finds something worth keeping', 0.4);
      } else if (roll < 0.8) {
        c.inventory.coins += 1;
        addEvent(state, 'food', 'finds a coin in the dirt and is pleased with himself', 0.45);
      } else {
        addEvent(state, 'food', 'turns something over and finds nothing, twice', 0.2);
      }
      break;
    }
    case 'eat': {
      const hungry = c.needs.hunger > 0.45;
      if (place === 'nest') c.inventory.food = Math.max(0, c.inventory.food - 1);
      else if (c.inventory.coins > 0) c.inventory.coins -= 1;
      else c.inventory.food = Math.max(0, c.inventory.food - 1);
      applyNeedDelta(state, { hunger: -0.55 }, 1);
      applyMoodDelta(state, { valence: hungry ? 0.16 : 0 });
      c.lastMealAt = now;
      addEvent(state, 'food', hungry ? 'eats like it is the first thing he has eaten' : 'eats because it is there, not because he wanted it', hungry ? 0.6 : 0.1);
      break;
    }
    case 'drink': {
      c.inventory.coins -= 1;
      applyNeedDelta(state, { hunger: 0.03, unease: -0.2 });
      applyMoodDelta(state, { valence: 0.2, energy: 0.22 });
      addEvent(state, 'bar', 'has one drink and takes a long time over it', 0.4);
      break;
    }
    case 'dance': {
      applyMoodDelta(state, { valence: 0.28, energy: 0.2 });
      applyNeedDelta(state, { fatigue: 0.05 });
      addEvent(state, 'joy', 'dances with his eyes shut and no idea what his feet are doing', 0.7);
      break;
    }
    case 'read': {
      applyNeedDelta(state, { curiosity: -0.45 });
      applyMoodDelta(state, { valence: 0.1 });
      addEvent(state, 'read', 'reads sitting on the floor between two shelves', 0.45);
      break;
    }
    case 'groom': {
      c.inventory.coins -= 1;
      applyMoodDelta(state, { valence: 0.18 });
      applyNeedDelta(state, { unease: -0.22 });
      addEvent(state, 'groom', 'lets somebody else decide what his feathers should do', 0.35);
      break;
    }
    case 'launder': {
      applyNeedDelta(state, { unease: -0.18, curiosity: -0.12 });
      applyMoodDelta(state, { valence: 0.08 });
      addEvent(state, 'quiet', 'watches the drums go round the whole time and does not blink', 0.35);
      break;
    }
    case 'doze': {
      applyNeedDelta(state, { fatigue: -0.14 });
      addEvent(state, 'rest', 'dozes off sitting upright, like a dropped doll', 0.2);
      break;
    }
    case 'sleep': {
      c.asleep = false;
      applyNeedDelta(state, { fatigue: -0.85 });
      applyMoodDelta(state, { valence: 0.05 });
      addEvent(state, 'sleep', 'wakes up slowly and does not know what day it is', 0.5);
      break;
    }
    case 'browse': {
      applyNeedDelta(state, { curiosity: -0.3 });
      addEvent(state, 'read', 'sits with the little screen and goes somewhere else for a while', 0.3);
      break;
    }
    case 'stargaze': {
      applyMoodDelta(state, { valence: 0.2 });
      applyNeedDelta(state, { unease: -0.16 });
      addEvent(state, 'quiet', 'lies back and looks at whatever is up there', 0.45);
      break;
    }
    case 'call': {
      const line = PAYPHONE_LINES[Math.floor(Math.random() * PAYPHONE_LINES.length)];
      applyNeedDelta(state, { curiosity: -0.15 });
      addEvent(state, 'odd', `makes a call: ${line}`, 0.5);
      break;
    }
    case 'sit': {
      applyMoodDelta(state, { valence: 0.06 });
      applyNeedDelta(state, { unease: -0.1 });
      addEvent(state, 'quiet', 'sits down and lets the town make its noises at him', 0.15);
      break;
    }
    case 'write_diary': {
      applyMoodDelta(state, { valence: 0.1 });
      addEvent(state, 'diary', 'writes the day down, badly, and is satisfied', 0.6);
      break;
    }
    case 'wander': {
      applyNeedDelta(state, { curiosity: -0.09 });
      addEvent(state, 'move', 'wanders without a destination and gets one anyway', 0.15);
      break;
    }
    default: {
      addEvent(state, 'act', `finishes ${getSpec(id)?.label ?? id}`, 0.1);
    }
  }

  state.actionsToday[id] = (state.actionsToday[id] ?? 0) + 0;
  // feeding the routine detector
  if (place) state.visitedToday[place] = (state.visitedToday[place] ?? 0) + 0;

  return { id, args: action.args, finishedAt: now };
}
