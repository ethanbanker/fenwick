import { findPath, circleTiles, type Point } from '../util/geo.ts';
import { makeRng } from '../util/text.ts';

/** Tile codes. The renderer switches on these. */
export const T = {
  grass: 0,
  road: 1,
  water: 2,
  plaza: 3,
  building: 4,
  tree: 5,
  rubble: 6,
  sand: 7,
  dirt: 8,
} as const;

export type PropKind = 'tree' | 'lamp' | 'bench' | 'payphone' | 'fountain' | 'flower' | 'crate' | 'grave';

export type Prop = {
  id: string;
  kind: PropKind;
  x: number;
  y: number;
  /** props that block movement */
  solid: boolean;
  variant: number;
};

export type Rect = { x: number; y: number; w: number; h: number };

export type Place = {
  id: string;
  name: string;
  kind: 'house' | 'shop' | 'public' | 'area';
  rect: Rect;
  door: Point;
  palette: { roof: string; wall: string; trim: string };
  tags: string[];
  /** one line the creature can recall about what this place is for */
  blurb: string;
};

export type Town = {
  w: number;
  h: number;
  tiles: Uint8Array;
  places: Place[];
  props: Prop[];
  spawn: Point;
};

const PALETTES = {
  nest: { roof: '#8f5a3c', wall: '#e8d8b9', trim: '#5b3a28' },
  bakery: { roof: '#c56a4a', wall: '#f2e3c6', trim: '#7a3f2c' },
  laundrette: { roof: '#5f8fa8', wall: '#e7eef2', trim: '#3d6377' },
  bar: { roof: '#6b4a6f', wall: '#dcc9d9', trim: '#412c45' },
  library: { roof: '#4f6b52', wall: '#e4ddc7', trim: '#32452f' },
  market: { roof: '#b08a3e', wall: '#efe0bf', trim: '#6d5525' },
  salon: { roof: '#a8557a', wall: '#f0dbe4', trim: '#6b3450' },
  tower: { roof: '#4a5a6b', wall: '#cfd6dd', trim: '#2d3945' },
} as const;

function blank(w: number, h: number, fill: number): Uint8Array {
  const tiles = new Uint8Array(w * h);
  tiles.fill(fill);
  return tiles;
}

export function buildTown(seed = 1337): Town {
  const w = 36;
  const h = 36;
  const tiles = blank(w, h, T.grass);
  const rng = makeRng(seed);
  const props: Prop[] = [];

  const set = (x: number, y: number, t: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    tiles[y * w + x] = t;
  };
  const get = (x: number, y: number) => tiles[y * w + x];

  // ---- water: a pond in the south-east, with a sand shore ----
  const pond = { cx: 31, cy: 30, rx: 4.2, ry: 3.4 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x - pond.cx) / pond.rx;
      const ny = (y - pond.cy) / pond.ry;
      const d = nx * nx + ny * ny;
      if (d <= 1) set(x, y, T.water);
      else if (d <= 1.55) set(x, y, T.sand);
    }
  }

  // ---- ruins: a patch of rubble in the south-west ----
  for (let y = 24; y <= 32; y++) {
    for (let x = 3; x <= 10; x++) {
      if (rng() < 0.72) set(x, y, T.rubble);
      else set(x, y, T.dirt);
    }
  }

  // ---- park: open grass with a dirt clearing, north-west of the plaza ----
  for (let y = 15; y <= 23; y++) {
    for (let x = 2; x <= 8; x++) {
      if (rng() < 0.35) set(x, y, T.dirt);
    }
  }

  // ---- buildings ----
  const places: Place[] = [];
  const addPlace = (p: Place) => {
    places.push(p);
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++) {
      for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++) set(x, y, T.building);
    }
  };

  addPlace({
    id: 'nest',
    name: 'Crooked House',
    kind: 'house',
    rect: { x: 10, y: 11, w: 3, h: 3 },
    door: { x: 11, y: 14 },
    palette: PALETTES.nest,
    tags: ['home', 'sleep', 'warm', 'private'],
    blurb: 'a small crooked house with a round door and too many blankets',
  });
  addPlace({
    id: 'bakery',
    name: 'Crumb & Crust',
    kind: 'shop',
    rect: { x: 21, y: 11, w: 4, h: 3 },
    door: { x: 22, y: 14 },
    palette: PALETTES.bakery,
    tags: ['food', 'smell', 'morning'],
    blurb: 'the bakery, warm and loud in the early hours, everything dusted with flour',
  });
  addPlace({
    id: 'laundrette',
    name: "Sudsy's",
    kind: 'shop',
    rect: { x: 9, y: 20, w: 4, h: 3 },
    door: { x: 10, y: 23 },
    palette: PALETTES.laundrette,
    tags: ['quiet', 'steam', 'sitting'],
    blurb: 'the laundrette, all steam and tumbling drums, a good place to sit and think',
  });
  addPlace({
    id: 'bar',
    name: 'The Wet Feather',
    kind: 'shop',
    rect: { x: 21, y: 20, w: 5, h: 4 },
    door: { x: 23, y: 24 },
    palette: PALETTES.bar,
    tags: ['drink', 'music', 'crowd', 'night'],
    blurb: 'the bar, low light and loud music and a floor that sticks slightly',
  });
  addPlace({
    id: 'library',
    name: 'Fenwick Library',
    kind: 'public',
    rect: { x: 3, y: 10, w: 4, h: 4 },
    door: { x: 7, y: 12 },
    palette: PALETTES.library,
    tags: ['books', 'quiet', 'shelter', 'reading'],
    blurb: 'the library, tall shelves and a radiator that ticks',
  });
  addPlace({
    id: 'market',
    name: 'The Market',
    kind: 'shop',
    rect: { x: 26, y: 20, w: 4, h: 4 },
    door: { x: 27, y: 24 },
    palette: PALETTES.market,
    tags: ['food', 'noise', 'people', 'trade'],
    blurb: 'the market, crates of things, prices shouted across the aisle',
  });
  addPlace({
    id: 'salon',
    name: 'The Salon',
    kind: 'shop',
    rect: { x: 4, y: 4, w: 4, h: 3 },
    door: { x: 5, y: 7 },
    palette: PALETTES.salon,
    tags: ['mirror', 'grooming', 'warm', 'chat'],
    blurb: 'the salon, a wall of mirrors and the smell of something chemical',
  });
  addPlace({
    id: 'tower',
    name: 'The Old Tower',
    kind: 'public',
    rect: { x: 27, y: 4, w: 4, h: 4 },
    door: { x: 28, y: 8 },
    palette: PALETTES.tower,
    tags: ['high', 'view', 'night', 'quiet'],
    blurb: 'the old clock tower, a long stair and a view over all of Fenwick',
  });
  addPlace({
    id: 'park',
    name: 'Verdigris Park',
    kind: 'area',
    rect: { x: 2, y: 15, w: 7, h: 7 },
    door: { x: 5, y: 18 },
    palette: { roof: '#4c7a45', wall: '#7fa06b', trim: '#2f4f2b' },
    tags: ['outside', 'trees', 'birds', 'quiet', 'forage'],
    blurb: 'the park, overgrown and full of small noises',
  });
  addPlace({
    id: 'pond',
    name: 'The Pond',
    kind: 'area',
    rect: { x: 28, y: 27, w: 6, h: 5 },
    door: { x: 29, y: 27 },
    palette: { roof: '#2f6b7a', wall: '#7fb0bb', trim: '#1e4a55' },
    tags: ['water', 'outside', 'reflection', 'calm'],
    blurb: 'the pond, green water and a duck that does not respect him',
  });
  addPlace({
    id: 'ruins',
    name: 'The Ruins',
    kind: 'area',
    rect: { x: 4, y: 25, w: 6, h: 6 },
    door: { x: 6, y: 28 },
    palette: { roof: '#6a655c', wall: '#9a938a', trim: '#4a463f' },
    tags: ['broken', 'outside', 'kept things', 'memorial'],
    blurb: 'the ruins, where the things he decided to keep are left standing',
  });
  addPlace({
    id: 'plaza',
    name: 'The Fountain',
    kind: 'area',
    rect: { x: 15, y: 15, w: 6, h: 6 },
    door: { x: 17, y: 20 },
    palette: { roof: '#8d8578', wall: '#b9b3a6', trim: '#5f594f' },
    tags: ['centre', 'water', 'lamplight', 'people'],
    blurb: 'the roundabout at the middle of everything, water running over stone',
  });

  // ---- roads: two crossing main roads, a plaza, and a few side streets ----
  for (let x = 0; x < w; x++) {
    set(x, 16, T.road);
    set(x, 17, T.road);
  }
  for (let y = 0; y < h; y++) {
    set(16, y, T.road);
    set(17, y, T.road);
  }
  for (const p of circleTiles(17, 17, 5)) set(p.x, p.y, T.plaza);
  // a side street to the tower
  for (let y = 4; y <= 16; y++) set(33, y, T.road);
  for (let x = 30; x <= 33; x++) set(x, 5, T.road);

  // Buildings win over roads.
  for (const p of places) {
    if (p.kind === 'area') continue;
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++) {
      for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++) tiles[y * w + x] = T.building;
    }
  }
  // Re-apply plaza centre after buildings.
  for (const p of circleTiles(17, 17, 5)) if (get(p.x, p.y) === T.grass) set(p.x, p.y, T.plaza);

  const walkableNow = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const t = get(x, y);
    return t !== T.building && t !== T.water && t !== T.tree;
  };

  // ---- carve a footpath from every door to the nearest main road ----
  const roadTargets: Point[] = [];
  for (let x = 0; x < w; x++) {
    roadTargets.push({ x, y: 16 }, { x, y: 17 });
  }
  for (let y = 0; y < h; y++) {
    roadTargets.push({ x: 16, y }, { x: 17, y });
  }

  const nearestRoad = (p: Point): Point => {
    let best = roadTargets[0];
    let bestD = Infinity;
    for (const r of roadTargets) {
      const d = Math.abs(r.x - p.x) + Math.abs(r.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  };

  for (const p of places) {
    if (p.id === 'plaza') continue;
    const target = nearestRoad(p.door);
    const path = findPath(p.door, target, walkableNow, w, h);
    for (const step of path) {
      const t = get(step.x, step.y);
      if (t === T.grass || t === T.dirt) set(step.x, step.y, T.road);
    }
    // make sure the doorstep itself is clear
    if (get(p.door.x, p.door.y) === T.building) {
      const below = { x: p.door.x, y: p.door.y + 1 };
      if (walkableNow(below.x, below.y)) set(below.x, below.y, T.road);
    }
  }

  // ---- forest ring and park trees ----
  let propId = 0;
  const addProp = (kind: PropKind, x: number, y: number, solid: boolean, variant = 0) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const t = get(x, y);
    if (t === T.building || t === T.water) return;
    if (props.some((p) => p.x === x && p.y === y)) return;
    props.push({ id: `p${propId++}`, kind, x, y, solid, variant });
    if (solid) set(x, y, T.tree);
  };

  const doorTiles = new Set(places.map((p) => `${p.door.x},${p.door.y}`));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = get(x, y);
      if (t !== T.grass) continue;
      if (doorTiles.has(`${x},${y}`)) continue;
      const edge = x < 2 || y < 2 || x > w - 3 || y > h - 3;
      const inPark = x >= 2 && x <= 8 && y >= 15 && y <= 23;
      const nearRoad = get(x + 1, y) === T.road || get(x - 1, y) === T.road || get(x, y + 1) === T.road || get(x, y - 1) === T.road;
      if (nearRoad) continue;
      if (edge && rng() < 0.55) addProp('tree', x, y, true, Math.floor(rng() * 3));
      else if (inPark && rng() < 0.16) addProp('tree', x, y, true, 2);
      else if (rng() < 0.05) addProp('flower', x, y, false, Math.floor(rng() * 3));
    }
  }

  // ---- street furniture ----
  const lamps: Point[] = [
    { x: 14, y: 15 }, { x: 20, y: 15 }, { x: 14, y: 18 }, { x: 20, y: 18 },
    { x: 15, y: 12 }, { x: 18, y: 12 }, { x: 15, y: 21 }, { x: 18, y: 21 },
    { x: 9, y: 16 }, { x: 24, y: 16 }, { x: 16, y: 9 }, { x: 17, y: 24 },
    { x: 16, y: 30 }, { x: 31, y: 16 }, { x: 5, y: 16 },
  ];
  for (const l of lamps) addProp('lamp', l.x, l.y, false, 0);
  for (const b of [{ x: 13, y: 19 }, { x: 21, y: 19 }, { x: 19, y: 13 }, { x: 14, y: 21 }]) {
    addProp('bench', b.x, b.y, false, 0);
  }
  addProp('payphone', 12, 18, false, 0);
  addProp('fountain', 17, 17, true, 0);
  for (const c of [{ x: 8, y: 19 }, { x: 9, y: 23 }, { x: 7, y: 22 }]) addProp('crate', c.x, c.y, false, 0);
  for (const g of [{ x: 5, y: 27 }, { x: 7, y: 31 }, { x: 9, y: 26 }, { x: 4, y: 30 }]) {
    addProp('grave', g.x, g.y, false, 0);
  }

  return {
    w,
    h,
    tiles,
    places,
    props,
    spawn: { x: 17, y: 20 },
  };
}

export function tileAt(town: Town, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= town.w || iy >= town.h) return T.building;
  return town.tiles[iy * town.w + ix];
}

export function isWalkable(town: Town, x: number, y: number): boolean {
  const t = tileAt(town, x, y);
  return t !== T.building && t !== T.water && t !== T.tree;
}

export function placeAt(town: Town, x: number, y: number): Place | null {
  for (const p of town.places) {
    if (x >= p.rect.x - 1 && x < p.rect.x + p.rect.w + 1 && y >= p.rect.y - 1 && y < p.rect.y + p.rect.h + 1) {
      return p;
    }
  }
  return null;
}

export function nearestPlace(town: Town, p: Point): Place {
  let best = town.places[0];
  let bestD = Infinity;
  for (const place of town.places) {
    const d = Math.hypot(place.door.x - p.x, place.door.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = place;
    }
  }
  return best;
}
