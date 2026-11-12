import type { Town } from './map.ts';
import type { CreationKind } from '../util/creation-kinds.ts';
import type { WorldState } from './state.ts';

/**
 * The thing he currently wants to exist.
 *
 * Building used to be an option with no reason attached. A want gives it a
 * shape and a place: one object at a time, said plainly, so a beat has
 * something to aim at besides hunger. Finishing something of the right kind
 * clears it and the next one forms on the following tick.
 */

const WANTS: Array<{ kind: CreationKind; text: (place: string) => string }> = [
  { kind: 'light', text: (place) => `a light for ${place}` },
  { kind: 'seat', text: (place) => `somewhere to sit near ${place}` },
  { kind: 'garden', text: (place) => `something growing near ${place}` },
  { kind: 'sign', text: (place) => `a sign worth reading near ${place}` },
  { kind: 'shelter', text: (place) => `somewhere out of the weather near ${place}` },
  { kind: 'ornament', text: (place) => `something worth looking at near ${place}` },
];

export function formWant(state: WorldState, town: Town): { kind: CreationKind; text: string; place: string | null; setDay: number } {
  const places = town.places.filter((p) => p.kind !== 'area');
  const seed = state.creations.length + state.clock.day;
  const place = places.length ? places[seed % places.length] : null;
  const want = WANTS[seed % WANTS.length];
  const name = place ? place.name.replace(/^The\s+/i, 'the ') : 'the street';
  return { kind: want.kind, text: want.text(name), place: place?.id ?? null, setDay: state.clock.day };
}

/** One open want at a time; an old one stops pulling after a few days. */
export function ensureProject(state: WorldState, town: Town): void {
  if (state.project && state.clock.day - state.project.setDay > 4) state.project = null;
  if (!state.project) state.project = formWant(state, town);
}
