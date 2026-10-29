import type { Observation } from './types.ts';

export type Decision = {
  id: string;
  args: Record<string, unknown>;
  reason: string;
  thought: string;
  /** how this decision was reached, shown in logs and the HUD */
  via: 'model' | 'reflex';
};

const MURMURS = [
  'fine. this is fine.',
  'something has to happen.',
  'right.',
  'the day is going to happen whether or not I help it.',
  'I could just stand here. I am not going to.',
  'nobody is watching. still.',
  'start with the legs.',
];

/**
 * The reflex brain. Used when there is no API key, the daily budget is spent, or
 * the model returned something the world would not accept. It is deliberately
 * simple: highest pull wins, with a dampener on anything he has just done.
 */
export function reflexDecision(obs: Observation, seedShuffle = Math.random): Decision {
  const options = obs.available ?? [];
  if (!options.length) {
    return {
      id: 'wander',
      args: {},
      reason: 'nothing is possible, so he walks',
      thought: 'just walk.',
      via: 'reflex',
    };
  }

  const recent = obs.routine?.recent ?? [];
  const visited = obs.routine?.visitedToday ?? {};

  const scored = options.map((o) => {
    // the reflex brain prefers doing something where he already stands
    let score = o.pull + (o.here ? 0.1 : 0) + seedShuffle() * 0.12;
    const repeatCount = recent.filter((r) => r === o.id).length;
    score -= repeatCount * 0.12;
    if (o.id === 'go_to') {
      const place = String(o.args.place ?? '');
      score -= (visited[place] ?? 0) * 0.14;
    }
    // essential needs cut through the repetition dampener
    if (o.id === 'eat' && obs.creature.needs.hunger > 0.75) score += 0.5;
    if (o.id === 'sleep' && obs.creature.needs.fatigue > 0.8) score += 0.6;
    if (o.id === 'inspect') score += 0.3;
    return { option: o, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0].option;

  const needs = obs.creature.needs;
  const reasons: string[] = [];
  if (chosen.id === 'eat') reasons.push(`hunger at ${Math.round(needs.hunger * 100)}%`);
  else if (chosen.id === 'sleep') reasons.push('he is falling asleep standing up');
  else if (chosen.id === 'inspect') reasons.push('there is something there that was not there before');
  else reasons.push(chosen.description);
  if (obs.creature.mood.valence < -0.3) reasons.push('and he is in a mood');

  return {
    id: chosen.id,
    args: chosen.args,
    reason: reasons.join(', '),
    thought: MURMURS[Math.floor(seedShuffle() * MURMURS.length)] ?? 'fine.',
    via: 'reflex',
  };
}
