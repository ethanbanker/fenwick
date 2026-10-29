import type { Point } from '../util/geo.ts';
import { buildTown, type Town } from './map.ts';
import type { Config } from '../config.ts';

export type NeedKey = 'hunger' | 'fatigue' | 'curiosity' | 'unease';

export type Needs = Record<NeedKey, number>;

export type Mood = { valence: number; energy: number };

export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'fog' | 'wind';

export type OfferingState = 'waiting' | 'noticed' | 'found' | 'kept' | 'released';

export type Offering = {
  id: string;
  from: string;
  text: string;
  imagePath: string | null;
  imageMime: string | null;
  tile: Point;
  state: OfferingState;
  createdAt: number;
  foundAt: number | null;
  verdict: string | null;
  kept: boolean;
  /** score the creature gave it, -1..1 */
  feeling: number | null;
  replies: string[];
};

export type WorldEvent = {
  id: number;
  day: number;
  minutes: number;
  at: number;
  kind: string;
  text: string;
  salience: number;
};

export type ActiveAction = {
  id: string;
  label: string;
  reason: string;
  thought: string;
  args: Record<string, unknown>;
  startedAt: number;
  endsAt: number;
  phase: 'moving' | 'doing';
};

export type Creature = {
  name: string;
  pos: Point;
  facing: 'n' | 's' | 'e' | 'w';
  path: Point[];
  speed: number;
  needs: Needs;
  mood: Mood;
  action: ActiveAction | null;
  lastMealAt: number;
  cooldowns: Record<string, number>;
  inventory: { food: number; coins: number; trinkets: number };
  asleep: boolean;
  atPlace: string | null;
  /** what he is carrying around in his head right now */
  moodNote: string;
};

export type WorldState = {
  version: number;
  seed: number;
  createdAt: number;
  savedAt: number;
  clock: { day: number; minutes: number };
  weather: { kind: WeatherKind; since: number; nextChange: number };
  creature: Creature;
  offerings: Offering[];
  events: WorldEvent[];
  eventSeq: number;
  visitedToday: Record<string, number>;
  actionsToday: Record<string, number>;
  actionHistory: string[];
  keptTotal: number;
  tick: number;
  lastFinished: { id: string; args: Record<string, unknown>; finishedAt: number } | null;
};

export const WEATHERS: WeatherKind[] = ['clear', 'clear', 'overcast', 'rain', 'fog', 'wind'];

export function createWorld(cfg: Config): { state: WorldState; town: Town } {
  const town = buildTown(cfg.sim.seed);
  const state: WorldState = {
    version: 1,
    seed: cfg.sim.seed,
    createdAt: Date.now(),
    savedAt: Date.now(),
    clock: { day: 1, minutes: 8 * 60 + 10 },
    weather: { kind: 'clear', since: Date.now(), nextChange: Date.now() + 3 * 3600_000 },
    creature: {
      name: cfg.creature.name,
      pos: { x: town.spawn.x, y: town.spawn.y },
      facing: 's',
      path: [],
      speed: 1.9,
      needs: { hunger: 0.42, fatigue: 0.28, curiosity: 0.35, unease: 0.18 },
      mood: { valence: 0.12, energy: 0.55 },
      action: null,
      lastMealAt: 0,
      cooldowns: {},
      inventory: { food: 2, coins: 3, trinkets: 0 },
      asleep: false,
      atPlace: 'plaza',
      moodNote: 'ears up, unsure what the day wants from him',
    },
    offerings: [],
    events: [],
    eventSeq: 1,
    visitedToday: {},
    actionsToday: {},
    actionHistory: [],
    keptTotal: 0,
    tick: 0,
    lastFinished: null,
  };
  return { state, town };
}

export function addEvent(
  state: WorldState,
  kind: string,
  text: string,
  salience = 0.3,
): WorldEvent {
  const ev: WorldEvent = {
    id: state.eventSeq++,
    day: state.clock.day,
    minutes: Math.round(state.clock.minutes),
    at: Date.now(),
    kind,
    text,
    salience,
  };
  state.events.push(ev);
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300);
  return ev;
}

/** In-world hours elapsed for a given real-time duration. */
export function hoursElapsed(cfg: Config, dtSeconds: number): number {
  const realMinutesPerWorldDay = cfg.sim.dayLengthMinutes;
  const worldHoursPerRealSecond = 24 / (realMinutesPerWorldDay * 60);
  return dtSeconds * worldHoursPerRealSecond;
}

export function msForWorldMinutes(cfg: Config, worldMinutes: number): number {
  const realMsPerWorldMinute = (cfg.sim.dayLengthMinutes * 60_000) / 1440;
  return worldMinutes * realMsPerWorldMinute;
}

export function advanceClock(cfg: Config, state: WorldState, dtSeconds: number): void {
  const realMsPerWorldMinute = (cfg.sim.dayLengthMinutes * 60_000) / 1440;
  state.clock.minutes += (dtSeconds * 1000) / realMsPerWorldMinute;
  while (state.clock.minutes >= 1440) {
    state.clock.minutes -= 1440;
    state.clock.day += 1;
    state.visitedToday = {};
    state.actionsToday = {};
    addEvent(state, 'day', `a new day starts. day ${state.clock.day}.`, 0.6);
  }
}

export function hourOfDay(state: WorldState): number {
  return state.clock.minutes / 60;
}

export function timeLabel(state: WorldState): string {
  const h = Math.floor(state.clock.minutes / 60);
  const m = Math.floor(state.clock.minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isNight(state: WorldState): boolean {
  const h = hourOfDay(state);
  return h < 6.2 || h >= 19.5;
}

export function darkness(state: WorldState): number {
  const h = hourOfDay(state);
  // 0 at midday, 1 deep night, smooth dawn/dusk
  if (h >= 20 || h < 5) return 1;
  if (h >= 17) return (h - 17) / 3;
  if (h < 7) return 1 - (h - 5) / 2;
  return 0;
}
