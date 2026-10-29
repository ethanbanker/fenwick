/** Grid geometry, distance and A* pathfinding over the town grid. */

export type Point = { x: number; y: number };

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function sameTile(a: Point, b: Point): boolean {
  return Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y);
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * A* over a grid. `walkable(x,y)` decides passable tiles. Diagonal moves are not
 * allowed to squeeze through the corner between two blocked tiles.
 */
export function findPath(
  from: Point,
  to: Point,
  walkable: (x: number, y: number) => boolean,
  width: number,
  height: number,
): Point[] {
  const start: Point = { x: Math.floor(from.x), y: Math.floor(from.y) };
  const goal: Point = { x: Math.floor(to.x), y: Math.floor(to.y) };
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!walkable(goal.x, goal.y)) {
    const alt = nearestWalkable(goal, walkable, width, height);
    if (!alt) return [];
    goal.x = alt.x;
    goal.y = alt.y;
  }
  const key = (x: number, y: number) => y * width + x;
  const open: Array<{ x: number; y: number; f: number; g: number }> = [];
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();
  const closed = new Set<number>();
  gScore.set(key(start.x, start.y), 0);
  open.push({ x: start.x, y: start.y, f: manhattan(start, goal), g: 0 });

  let guard = 0;
  while (open.length && guard++ < 40_000) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const current = open.splice(bestIdx, 1)[0];
    const ck = key(current.x, current.y);
    if (current.x === goal.x && current.y === goal.y) {
      const path: Point[] = [];
      let k: number | undefined = ck;
      while (k !== undefined) {
        path.push({ x: k % width, y: Math.floor(k / width) });
        k = cameFrom.get(k);
      }
      path.reverse();
      path.shift();
      return path;
    }
    closed.add(ck);
    for (const [dx, dy, cost] of NEIGHBOURS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!walkable(nx, ny)) continue;
      if (dx !== 0 && dy !== 0) {
        // no corner cutting
        if (!walkable(current.x + dx, current.y) || !walkable(current.x, current.y + dy)) continue;
      }
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentative = current.g + cost;
      const known = gScore.get(nk);
      if (known !== undefined && tentative >= known) continue;
      gScore.set(nk, tentative);
      cameFrom.set(nk, ck);
      open.push({ x: nx, y: ny, f: tentative + manhattan({ x: nx, y: ny }, goal), g: tentative });
    }
  }
  return [];
}

export function nearestWalkable(
  p: Point,
  walkable: (x: number, y: number) => boolean,
  width: number,
  height: number,
  maxRadius = 6,
): Point | null {
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.floor(p.x) + dx;
        const y = Math.floor(p.y) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (walkable(x, y)) return { x, y };
      }
    }
  }
  return null;
}

/** Bresenham line, used to carve straight roads between two points. */
export function line(from: Point, to: Point): Point[] {
  const out: Point[] = [];
  let x0 = Math.floor(from.x);
  let y0 = Math.floor(from.y);
  const x1 = Math.floor(to.x);
  const y1 = Math.floor(to.y);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let guard = 0;
  while (guard++ < 4096) {
    out.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

export function circleTiles(cx: number, cy: number, r: number): Point[] {
  const out: Point[] = [];
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r + r * 0.6) out.push({ x: cx + x, y: cy + y });
    }
  }
  return out;
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
