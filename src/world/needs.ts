import type { Config } from '../config.ts';
import { type WorldState, type Needs, type Mood, hoursElapsed, hourOfDay, isNight } from './state.ts';
import { clamp } from '../util/text.ts';

/** How fast each need fills, per in-world hour. */
/**
 * Per in-world hour. One in-world day is one real hour by default, so these are
 * also roughly "per day / 24": hunger reaches starving in about 8 waking hours,
 * which asks for three meals a day rather than a treadmill.
 */
const DRIFT: Record<keyof Needs, number> = {
  hunger: 0.075,
  fatigue: 0.055,
  curiosity: 0.1,
  unease: 0.04,
};

function weatherBias(kind: string): number {
  switch (kind) {
    case 'clear':
      return 0.12;
    case 'overcast':
      return -0.03;
    case 'rain':
      return -0.16;
    case 'fog':
      return -0.06;
    case 'wind':
      return 0.02;
    default:
      return 0;
  }
}

/** Owls: awake and bright at night, dim and sleepy through the middle of the day. */
function circadianEnergy(hour: number): number {
  const x = ((hour % 24) + 24) % 24;
  // peak at 22:00 and 02:00, trough at 12:00
  const peak = Math.cos(((x - 22) / 24) * Math.PI * 2);
  return clamp(0.5 + 0.42 * peak, 0.05, 0.98);
}

export function advanceNeeds(cfg: Config, state: WorldState, dtSeconds: number): void {
  const c = state.creature;
  const hours = hoursElapsed(cfg, dtSeconds);
  const asleep = c.asleep;

  c.needs.hunger = clamp(c.needs.hunger + DRIFT.hunger * hours * (asleep ? 0.55 : 1), 0, 1);
  c.needs.fatigue = clamp(
    c.needs.fatigue + (asleep ? -0.95 * hours : DRIFT.fatigue * hours * (c.mood.energy > 0.65 ? 1.25 : 1)),
    0,
    1,
  );
  c.needs.curiosity = clamp(c.needs.curiosity + DRIFT.curiosity * hours * (asleep ? 0 : 1), 0, 1);

  const atHome = c.atPlace === 'nest';
  const exposed = !atHome && (state.weather.kind === 'rain' || state.weather.kind === 'fog') && !asleep;
  c.needs.unease = clamp(
    c.needs.unease + (DRIFT.unease * hours * (exposed ? 2.4 : 0.6) - (atHome ? 0.3 * hours : 0)),
    0,
    1,
  );

  updateMood(cfg, state, dtSeconds);
}

export function updateMood(cfg: Config, state: WorldState, dtSeconds: number): void {
  const c = state.creature;
  const hour = hourOfDay(state);
  const target = moodTarget(state);
  // sheer time constant: mood moves a little every in-world minute
  const worldMinutes = (dtSeconds * 1000) / ((cfg.sim.dayLengthMinutes * 60_000) / 1440);
  const k = clamp(worldMinutes / 25, 0, 1);
  c.mood.valence = clamp(c.mood.valence + (target.valence - c.mood.valence) * k, -1, 1);

  const energyTarget = c.asleep ? 0.08 : circadianEnergy(hour) * (1 - 0.55 * c.needs.fatigue);
  const ke = clamp(worldMinutes / 18, 0, 1);
  c.mood.energy = clamp(c.mood.energy + (energyTarget - c.mood.energy) * ke, -1, 1);
}

export function moodTarget(state: WorldState): Mood {
  const n = state.creature.needs;
  let valence =
    0.62 * (1 - n.hunger) +
    0.34 * (1 - n.fatigue) +
    0.22 * (1 - n.unease) +
    0.18 * (1 - n.curiosity) -
    0.55;
  valence += weatherBias(state.weather.kind);
  if (isNight(state)) valence += 0.07;
  if (state.creature.atPlace === 'nest') valence += 0.08;
  if (state.creature.atPlace === 'ruins') valence -= 0.04;
  return { valence: clamp(valence, -1, 1), energy: state.creature.mood.energy };
}

export function applyNeedDelta(state: WorldState, delta: Partial<Needs>, scale = 1): void {
  for (const [key, value] of Object.entries(delta) as Array<[keyof Needs, number]>) {
    state.creature.needs[key] = clamp(state.creature.needs[key] + value * scale, 0, 1);
  }
}

export function applyMoodDelta(state: WorldState, delta: { valence?: number; energy?: number }): void {
  if (delta.valence) state.creature.mood.valence = clamp(state.creature.mood.valence + delta.valence, -1, 1);
  if (delta.energy) state.creature.mood.energy = clamp(state.creature.mood.energy + delta.energy, -1, 1);
}

export type MoodBand = 'low' | 'flat' | 'okay' | 'good' | 'bright';

export function moodBand(v: number): MoodBand {
  if (v < -0.5) return 'low';
  if (v < -0.15) return 'flat';
  if (v < 0.2) return 'okay';
  if (v < 0.55) return 'good';
  return 'bright';
}

export function energyBand(e: number): 'drowsy' | 'calm' | 'alert' | 'wired' {
  if (e < 0.2) return 'drowsy';
  if (e < 0.5) return 'calm';
  if (e < 0.78) return 'alert';
  return 'wired';
}

/** Plain-language readout used in the brain prompt and the HUD. */
export function describeNeedsValues(n: Needs): string {
  const word = (v: number, labels: [string, string, string, string]) =>
    v < 0.25 ? labels[0] : v < 0.5 ? labels[1] : v < 0.75 ? labels[2] : labels[3];
  return [
    `hunger ${word(n.hunger, ['gone', 'mild', 'sharp', 'gnawing'])}`,
    `tiredness ${word(n.fatigue, ['fresh', 'fine', 'heavy', 'bone-tired'])}`,
    `boredom ${word(n.curiosity, ['content', 'stirring', 'restless', 'climbing the walls'])}`,
    `unease ${word(n.unease, ['settled', 'faint', 'prickling', 'wound tight'])}`,
  ].join(', ');
}

export function describeNeeds(state: WorldState): string {
  return describeNeedsValues(state.creature.needs);
}

/** Reward gate: doing a thing you did not need gives nothing. */
export function rewardFor(need: keyof Needs, before: number, afterWanted: boolean): number {
  if (afterWanted) return 0;
  return need === 'hunger' ? 0.5 : need === 'fatigue' ? 0.45 : 0.35;
}

export function needUrgency(state: WorldState, key: keyof Needs, threshold = 0.6): number {
  const v = state.creature.needs[key];
  return v > threshold ? (v - threshold) / (1 - threshold) : 0;
}
