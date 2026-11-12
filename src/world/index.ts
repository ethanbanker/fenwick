import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, dataPath, ensureDir, ROOT } from '../config.ts';
import { SseHub, cors, readJson, sendHtml, sendJson, serveStatic } from '../util/http.ts';
import { buildTown, T, type Town } from './map.ts';
import {
  addEvent,
  advanceClock,
  createWorld,
  darkness,
  isNight,
  timeLabel,
  type Offering,
  type WorldState,
} from './state.ts';
import { advanceNeeds } from './needs.ts';
import { availableActions, completeAction, placeOf, startAction, type ActionContext } from './actions.ts';
import {
  applyKindHints,
  creationPreview,
  creationStage,
  decayCreations,
  syncCreations,
} from './creations.ts';
import { conditionWord, inferKind, isCreationKind, kindLabel } from '../util/creation-kinds.ts';
import { renderPage, type PageKind } from './pages.ts';
import { adminAuthorized, adminStatus, adminToken, updateKeys } from './admin.ts';
import { readThoughts } from '../brain/thoughts.ts';
import { decide as decideBench } from '../bench.ts';

const cfg = loadConfig();
const stateFile = dataPath(cfg, 'world-state.json');
const offeringDir = ensureDir(cfg, 'offerings');
const town: Town = buildTown(cfg.sim.seed);

function loadState(): WorldState {
  if (fs.existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as WorldState;
      // the map is derived, the rest is durable
      if (parsed?.creature && parsed?.clock) return parsed;
    } catch (err) {
      console.error(`[world] could not read save: ${(err as Error).message} — starting a new life`);
    }
  }
  return null as unknown as WorldState;
}

let state: WorldState;
const restored = loadState();
if (restored) {
  state = restored;
  state.creature.path = [];
  console.log(`[world] resumed day ${state.clock.day}, ${timeLabel(state)}`);
} else {
  state = createWorld(cfg).state;
  addEvent(state, 'life', `${cfg.creature.name} wakes up in ${cfg.town.name} for the first time`, 1);
  console.log('[world] a new life begins');
}

state.lastFinished = state.lastFinished ?? null;
// saves written before marks existed simply have none
state.marks = Array.isArray(state.marks) ? state.marks : [];
state.creations = Array.isArray(state.creations) ? state.creations : [];
// saves written before things had a purpose simply get one from their name
for (const made of state.creations) {
  if (!isCreationKind(made.kind)) made.kind = inferKind(made.name, creationPreview(cfg, made.file, 200));
  if (typeof made.condition !== 'number') made.condition = 1;
  if (typeof made.used !== 'number') made.used = 0;
  if (typeof made.mendedDay !== 'number') made.mendedDay = null;
}

const startedAt = Date.now();
let lastTick = Date.now();
let lastSave = Date.now();
let lastBroadcast = 0;
const sse = new SseHub();

function ctx(): ActionContext {
  return { cfg, state, town, now: Date.now() };
}

function save(): void {
  state.savedAt = Date.now();
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile);
  lastSave = Date.now();
}

function moveCreature(dtSeconds: number): void {
  const c = state.creature;
  if (!c.path.length) return;
  let remaining = c.speed * dtSeconds;
  let guard = 0;
  while (remaining > 0 && c.path.length && guard++ < 200) {
    const next = c.path[0];
    const tx = next.x + 0.5;
    const ty = next.y + 0.5;
    const dx = tx - c.pos.x;
    const dy = ty - c.pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= 0.0001) {
      c.path.shift();
      continue;
    }
    if (d <= remaining) {
      c.pos.x = tx;
      c.pos.y = ty;
      c.path.shift();
      remaining -= d;
      if (Math.abs(dx) > 0.01) c.facing = dx > 0 ? 'e' : 'w';
      else if (Math.abs(dy) > 0.01) c.facing = dy > 0 ? 's' : 'n';
    } else {
      c.pos.x += (dx / d) * remaining;
      c.pos.y += (dy / d) * remaining;
      c.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n';
      remaining = 0;
    }
  }
}

function updateWeather(now: number): void {
  if (now < state.weather.nextChange) return;
  const options: Array<{ k: WorldState['weather']['kind']; w: number }> = [
    { k: 'clear', w: 3 },
    { k: 'overcast', w: 2 },
    { k: 'rain', w: 2 },
    { k: 'fog', w: 1 },
    { k: 'wind', w: 1 },
  ];
  if (state.weather.kind === 'rain') {
    options.find((o) => o.k === 'clear')!.w = 1;
    options.find((o) => o.k === 'overcast')!.w = 4;
  }
  const total = options.reduce((s, o) => s + o.w, 0);
  let roll = Math.random() * total;
  let next = 'clear' as WorldState['weather']['kind'];
  for (const o of options) {
    roll -= o.w;
    if (roll <= 0) {
      next = o.k;
      break;
    }
  }
  state.weather.kind = next;
  state.weather.since = now;
  const worldHours = 1.5 + Math.random() * 3.5;
  const realMs = (worldHours / 24) * cfg.sim.dayLengthMinutes * 60_000;
  state.weather.nextChange = now + Math.max(60_000, realMs);
  addEvent(state, 'weather', `the weather turns to ${next}`, 0.4);
}

function senseOfferings(): void {
  const c = state.creature;
  for (const off of state.offerings) {
    if (off.state !== 'waiting') continue;
    const d = Math.hypot(off.tile.x + 0.5 - c.pos.x, off.tile.y + 0.5 - c.pos.y);
    if (d <= cfg.offerings.senseRadiusTiles) {
      off.state = 'noticed';
      addEvent(state, 'offering', `notices something glassy catching the light, left by ${off.from}`, 0.75);
    }
  }
}

function tick(): void {
  const now = Date.now();
  const dt = Math.min(0.5, (now - lastTick) / 1000);
  lastTick = now;
  state.tick += 1;

  advanceClock(cfg, state, dt);
  advanceNeeds(cfg, state, dt);
  moveCreature(dt);
  updateWeather(now);
  senseOfferings();
  // whatever he built in the workshop becomes a thing standing in the town,
  // with the purpose he gave it, coming apart slowly if he stops touching it
  syncCreations(cfg, state);
  applyKindHints(cfg, state);
  decayCreations(cfg, state, dt);

  const creaturePlace = placeOf(town, state.creature.pos);
  state.creature.atPlace = creaturePlace;

  const action = state.creature.action;
  if (action) {
    const arrived = action.phase === 'moving' && state.creature.path.length === 0;
    const elapsed = now >= action.endsAt;
    if (arrived || elapsed) {
      const finished = completeAction(ctx());
      if (finished) {
        state.lastFinished = finished;
        state.creature.atPlace = placeOf(town, state.creature.pos);
      }
    }
  }

  if (state.creature.asleep && state.creature.needs.hunger > 0.96) {
    if (state.creature.action?.id === 'sleep') {
      const finished = completeAction(ctx());
      if (finished) state.lastFinished = finished;
      addEvent(state, 'sleep', 'wakes up early because his stomach will not let him sleep', 0.4);
    }
  }

  if (now - lastSave > 30_000) save();

  if (now - lastBroadcast > 110) {
    lastBroadcast = now;
    broadcastState();
  }
}

function offeringsForWire(): unknown[] {
  // Uncollected crystals must never be pushed off the wire by ones he already
  // kept, or the map would quietly stop showing the thing you just left.
  const pending = state.offerings
    .filter((o) => o.state === 'waiting' || o.state === 'noticed' || o.state === 'found')
    .slice(-24);
  const kept = state.offerings.filter((o) => o.state === 'kept').slice(-16);
  return [...pending, ...kept]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((o) => ({ id: o.id, x: o.tile.x, y: o.tile.y, state: o.state, from: o.from, at: o.createdAt }));
}

function snapshot(): unknown {
  const c = state.creature;
  return {
    t: Date.now(),
    day: state.clock.day,
    time: timeLabel(state),
    minutes: state.clock.minutes,
    weather: state.weather.kind,
    night: isNight(state),
    darkness: darkness(state),
    creature: {
      name: c.name,
      x: c.pos.x,
      y: c.pos.y,
      facing: c.facing,
      asleep: c.asleep,
      moving: c.path.length > 0,
      needs: c.needs,
      mood: c.mood,
      action: c.action ? { id: c.action.id, label: c.action.label, thought: c.action.thought } : null,
      atPlace: c.atPlace,
      inventory: c.inventory,
    },
    offerings: offeringsForWire(),
    marks: state.marks.slice(-24).map((m) => ({ id: m.id, x: m.tile.x, y: m.tile.y, text: m.text, day: m.day })),
    creations: state.creations.slice(-24).map((c) => ({
      id: c.id,
      x: c.tile.x,
      y: c.tile.y,
      name: c.name,
      file: c.file,
      day: c.day,
      kind: c.kind,
      condition: Math.round(c.condition * 100) / 100,
      stage: creationStage(state, c),
    })),
    events: state.events.slice(-7).map((e) => ({ id: e.id, text: e.text, kind: e.kind, day: e.day })),
    keptTotal: state.keptTotal,
  };
}

function broadcastState(): void {
  sse.broadcast('state', snapshot());
}

const tickMs = Math.max(20, Math.round(1000 / cfg.sim.tickHz));
setInterval(tick, tickMs);

// ---------------------------------------------------------------- brain API

function observation(sinceEventId: number): unknown {
  const c = state.creature;
  const here = state.creature.atPlace;
  const place = town.places.find((p) => p.id === here) ?? null;
  const nearbyPLaces = town.places
    .map((p) => ({ id: p.id, name: p.name, tags: p.tags, distance: Math.round(Math.hypot(p.door.x - c.pos.x, p.door.y - c.pos.y) * 10) / 10 }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  const sight = Math.max(
    cfg.offerings.senseRadiusTiles + 1.5,
    cfg.offerings.sightRadiusTiles,
    cfg.offerings.spawnRadiusTiles + 2,
  );
  const sensed = state.offerings.filter((o) => {
    if (o.state === 'kept' || o.state === 'released') return false;
    return Math.hypot(o.tile.x - c.pos.x, o.tile.y - c.pos.y) <= sight;
  });

  return {
    tick: state.tick,
    now: Date.now(),
    day: state.clock.day,
    time: timeLabel(state),
    minutes: Math.round(state.clock.minutes),
    night: isNight(state),
    darkness: darkness(state),
    weather: state.weather.kind,
    creature: {
      name: c.name,
      x: Math.round(c.pos.x * 100) / 100,
      y: Math.round(c.pos.y * 100) / 100,
      facing: c.facing,
      needs: c.needs,
      mood: c.mood,
      asleep: c.asleep,
      action: c.action
        ? {
            id: c.action.id,
            label: c.action.label,
            reason: c.action.reason,
            thought: c.action.thought,
            startedAt: c.action.startedAt,
            endsAt: c.action.endsAt,
            remainingMs: Math.max(0, c.action.endsAt - Date.now()),
          }
        : null,
      inventory: c.inventory,
      atPlace: here,
      moodNote: c.moodNote,
    },
    place: place ? { id: place.id, name: place.name, tags: place.tags, blurb: place.blurb } : null,
    nearby: nearbyPLaces,
    available: availableActions(ctx()),
    events: state.events.filter((e) => e.id > sinceEventId).map((e) => ({ id: e.id, kind: e.kind, text: e.text, at: e.at })),
    offeringCrystals: sensed.map((o) => ({
      id: o.id,
      from: o.from,
      state: o.state,
      distance: Math.round(Math.hypot(o.tile.x - c.pos.x, o.tile.y - c.pos.y) * 10) / 10,
      waitingSince: o.createdAt,
    })),
    marks: state.marks
      .slice(-8)
      .reverse()
      .map((m) => ({
        text: m.text,
        day: m.day,
        distance: Math.round(Math.hypot(m.tile.x - c.pos.x, m.tile.y - c.pos.y) * 10) / 10,
      })),
    creations: state.creations
      .slice(-12)
      .reverse()
      .map((made) => {
        const stage = creationStage(state, made);
        const kind =
          made.kind === 'garden'
            ? `${kindLabel(made.kind)} (${['just planted', 'growing', 'ripe'][stage]})`
            : kindLabel(made.kind);
        return {
          name: made.name,
          file: made.file,
          kind,
          day: made.day,
          distance: Math.round(Math.hypot(made.tile.x - c.pos.x, made.tile.y - c.pos.y) * 10) / 10,
          condition: conditionWord(made.condition),
          stage,
          preview: creationPreview(cfg, made.file, 120),
        };
      }),
    pendingInspection: state.offerings
      .filter((o) => o.state === 'found')
      .map((o) => ({
        id: o.id,
        from: o.from,
        text: o.text,
        imagePath: o.imagePath,
        imageMime: o.imageMime,
      })),
    lastFinished: state.lastFinished,
    routine: {
      actionsToday: state.actionsToday,
      visitedToday: state.visitedToday,
      recent: state.actionHistory.slice(-12),
    },
    stats: { keptTotal: state.keptTotal, offeringCount: state.offerings.length },
  };
}

async function handleOffering(body: {
  from?: string;
  text?: string;
  imageBase64?: string;
  imageMime?: string;
}): Promise<{ ok: boolean; error?: string; offering?: Offering }> {
  const from = (body.from ?? '').trim().slice(0, 40) || 'someone';
  const text = (body.text ?? '').trim().slice(0, 1600);
  const hasImage = Boolean(body.imageBase64);
  if (!text && !hasImage) return { ok: false, error: 'say something or attach a picture' };

  const today = state.offerings.filter((o) => o.createdAt > Date.now() - 86_400_000).length;
  if (today >= cfg.offerings.perDayLimit) {
    return { ok: false, error: `he has already been left ${today} things today; try again tomorrow` };
  }

  const id = randomUUID().slice(0, 8);
  let imagePath: string | null = null;
  let imageMime: string | null = null;
  if (hasImage) {
    const mime = body.imageMime ?? 'image/png';
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png';
    const buf = Buffer.from(body.imageBase64!, 'base64');
    if (buf.length > 4_500_000) return { ok: false, error: 'that picture is too big (4MB max)' };
    const file = path.join(offeringDir, `${id}.${ext}`);
    fs.writeFileSync(file, buf);
    imagePath = file;
    imageMime = mime;
  }

  // spawn somewhere walkable within a ring around wherever he happens to be
  const spawn = pickSpawnTile();
  const offering: Offering = {
    id,
    from,
    text,
    imagePath,
    imageMime,
    tile: spawn,
    state: 'waiting',
    createdAt: Date.now(),
    foundAt: null,
    verdict: null,
    kept: false,
    feeling: null,
    replies: [],
  };
  state.offerings.push(offering);
  addEvent(state, 'offering', `somebody left a crystal in the town for him`, 0.5);
  fs.writeFileSync(
    path.join(offeringDir, `${id}.json`),
    JSON.stringify({ id, from, text, hasImage, createdAt: offering.createdAt }),
  );
  save();
  broadcastState();
  return { ok: true, offering };
}

function ruinTile(): { x: number; y: number } {
  const ruins = town.places.find((p) => p.id === 'ruins');
  if (!ruins) return { x: Math.floor(state.creature.pos.x), y: Math.floor(state.creature.pos.y) };
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = ruins.rect.x + Math.floor(Math.random() * ruins.rect.w);
    const y = ruins.rect.y + Math.floor(Math.random() * ruins.rect.h);
    const t = town.tiles[y * town.w + x];
    if (t === T.building || t === T.water || t === T.tree) continue;
    if (state.offerings.some((o) => o.kept && o.tile.x === x && o.tile.y === y)) continue;
    return { x, y };
  }
  return { x: ruins.door.x, y: ruins.door.y };
}

function pickSpawnTile(): { x: number; y: number } {
  const c = state.creature.pos;
  const blockedPlaces = new Set(['nest']);
  for (let attempt = 0; attempt < 400; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    // 4 tiles out to the edge of the ring, never past it
    const r = 4 + Math.random() * Math.max(1, cfg.offerings.spawnRadiusTiles - 4);
    const x = Math.floor(c.x + Math.cos(angle) * r);
    const y = Math.floor(c.y + Math.sin(angle) * r);
    if (x < 1 || y < 1 || x >= town.w - 1 || y >= town.h - 1) continue;
    const t = town.tiles[y * town.w + x];
    if (t === T.building || t === T.water || t === T.tree) continue;
    if (state.offerings.some((o) => o.tile.x === x && o.tile.y === y)) continue;
    const p = placeOf(town, { x: x + 0.5, y: y + 0.5 });
    if (p && blockedPlaces.has(p)) continue;
    return { x, y };
  }
  return { x: Math.floor(c.x), y: Math.floor(c.y) };
}

/** Kept crystals stay forever; the rest only need to be remembered for a while. */
function pruneOfferings(): void {
  if (state.offerings.length <= 120) return;
  const kept = state.offerings.filter((o) => o.kept);
  const recent = state.offerings.filter((o) => !o.kept).slice(-80);
  state.offerings = [...recent, ...kept].sort((a, b) => a.createdAt - b.createdAt);
}

function standingFor(from: string): { kept: number; label: string } {
  const kept = state.offerings.filter((o) => o.kept && o.from === from).length;
  const label =
    kept >= 10 ? 'one of his own' : kept >= 3 ? 'a familiar face' : kept >= 1 ? 'someone he knows' : 'a new face';
  return { kept, label };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (p === '/api/town') {
      sendJson(res, 200, {
        w: town.w,
        h: town.h,
        tiles: Array.from(town.tiles),
        places: town.places,
        props: town.props,
        townName: cfg.town.name,
        creatureName: cfg.creature.name,
        spawn: town.spawn,
      });
      return;
    }

    if (p === '/api/state') {
      sendJson(res, 200, snapshot());
      return;
    }

    if (p === '/api/thoughts') {
      const limit = Number(url.searchParams.get('limit') ?? 200);
      sendJson(res, 200, { ok: true, thoughts: readThoughts(cfg, Number.isFinite(limit) ? limit : 200) });
      return;
    }

    if (p === '/events') {
      sse.handle(req, res, { town: cfg.town.name, creature: cfg.creature.name, state: snapshot() });
      return;
    }

    if (p === '/api/observe') {
      const since = Number(url.searchParams.get('since') ?? 0);
      sendJson(res, 200, observation(Number.isFinite(since) ? since : 0));
      return;
    }

    if (p === '/api/action' && req.method === 'POST') {
      const body = await readJson<{ id?: string; args?: Record<string, unknown>; reason?: string; thought?: string }>(req);
      const id = String(body.id ?? '');
      const args = (body.args ?? {}) as Record<string, unknown>;
      const result = startAction(ctx(), id, args, String(body.reason ?? ''), String(body.thought ?? ''));
      if (!result.ok) {
        sendJson(res, 409, { ok: false, error: result.error, available: availableActions(ctx()) });
        return;
      }
      sendJson(res, 200, { ok: true, action: result.action.id, label: result.action.label });
      return;
    }

    if (p === '/api/verdict' && req.method === 'POST') {
      const body = await readJson<{ offeringId?: string; keep?: boolean; verdict?: string; reply?: string; feeling?: number }>(req);
      const off = state.offerings.find((o) => o.id === body.offeringId);
      if (!off) {
        sendJson(res, 404, { ok: false, error: 'no such offering' });
        return;
      }
      off.kept = Boolean(body.keep);
      off.state = body.keep ? 'kept' : 'released';
      off.verdict = String(body.verdict ?? '').slice(0, 600);
      off.feeling = typeof body.feeling === 'number' ? body.feeling : null;
      off.foundAt = Date.now();
      if (body.reply) off.replies.push(String(body.reply).slice(0, 600));
      if (body.keep) {
        state.keptTotal += 1;
        // kept things are carried to the ruins and stay there for good
        off.tile = ruinTile();
        addEvent(state, 'offering', `keeps what ${off.from} left and carries it to the ruins`, 0.9);
      } else {
        addEvent(state, 'offering', `reads what ${off.from} left, and lets it go`, 0.7);
      }
      pruneOfferings();
      save();
      broadcastState();
      sendJson(res, 200, { ok: true, standing: standingFor(off.from) });
      return;
    }

    if (p === '/api/reading' && req.method === 'POST') {
      const body = await readJson<{ url?: string; title?: string; opinion?: string; excerpt?: string; tags?: string[] }>(req);
      addEvent(state, 'read', `reads "${String(body.title ?? body.url ?? 'a page').slice(0, 90)}"`, 0.4);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (p === '/api/offering' && req.method === 'POST') {
    // (visitors leave things through here; he has to find them on his own)
      const body = await readJson<{ from?: string; text?: string; imageBase64?: string; imageMime?: string }>(req);
      const result = await handleOffering(body);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    if (p === '/api/standing') {
      const from = url.searchParams.get('from') ?? 'someone';
      sendJson(res, 200, { from, ...standingFor(from) });
      return;
    }

    // ------------------------------------------------------------- admin
    if (p === '/admin' || p === '/admin/') {
      const html = fs
        .readFileSync(path.join(ROOT, 'src', 'viewer', 'admin.html'), 'utf8')
        .replaceAll('__CREATURE__', cfg.creature.name)
        .replaceAll('__ADMIN__', cfg.town.name);
      sendHtml(res, 200, html);
      return;
    }

    if (p.startsWith('/api/admin/')) {
      if (!adminAuthorized(req.headers['x-admin-token'], cfg)) {
        sendJson(res, 401, { ok: false, error: 'admin token required' });
        return;
      }
      if (p === '/api/admin/status') {
        sendJson(res, 200, adminStatus(cfg));
        return;
      }
      if (p === '/api/admin/keys' && req.method === 'POST') {
        const body = await readJson<{ updates?: Record<string, unknown> }>(req);
        const result = updateKeys(cfg, body.updates ?? {});
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      if (p === '/api/admin/bench' && req.method === 'POST') {
        const body = await readJson<{ id?: string; decision?: string }>(req);
        const result = decideBench(cfg, String(body.id ?? ''), body.decision === 'approve');
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    // The town is the front door now: first person, no avatar, Mochi tracked live.
    if (p === '/' || p === '/walk' || p === '/walk/') {
      const html = fs
        .readFileSync(path.join(ROOT, 'src', 'viewer', 'walk.html'), 'utf8')
        .replaceAll('__CREATURE__', cfg.creature.name)
        .replaceAll('__TOWN__', cfg.town.name);
      sendHtml(res, 200, html);
      return;
    }

    // The old isometric map is still here, one click away.
    if (p === '/map' || p === '/map/') {
      const html = fs
        .readFileSync(path.join(ROOT, 'src', 'viewer', 'index.html'), 'utf8')
        .replaceAll('__CREATURE__', cfg.creature.name)
        .replaceAll('__TOWN__', cfg.town.name);
      sendHtml(res, 200, html);
      return;
    }

    const pageRoutes: Record<string, PageKind> = {
      '/diary': 'diary',
      '/memories': 'memories',
      '/mind': 'mind',
      '/offerings': 'offerings',
      '/thoughts': 'thoughts',
    };
    if (pageRoutes[p]) {
      const html = renderPage(pageRoutes[p], cfg, state, town, url);
      sendHtml(res, 200, html);
      return;
    }

    if (p.startsWith('/img/')) {
      const id = p.slice('/img/'.length).replace(/[^a-zA-Z0-9-]/g, '');
      const file = fs.readdirSync(offeringDir).find((f) => f.startsWith(id) && !f.endsWith('.json'));
      if (file) {
        const full = path.join(offeringDir, file);
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'max-age=300' });
        res.end(fs.readFileSync(full));
        return;
      }
      sendJson(res, 404, { error: 'no image' });
      return;
    }

    // His workshop: files he wrote himself, served in a sandboxed origin so a
    // page he made can never touch the admin token in this origin's storage.
    if (p.startsWith('/world/')) {
      const root = ensureDir(cfg, 'workshop');
      const rel = decodeURIComponent(p.slice('/world/'.length)).replace(/^\/+/, '');
      const file = path.resolve(root, rel);
      if (
        !rel ||
        rel.includes('..') ||
        !file.startsWith(root + path.sep) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
      ) {
        sendJson(res, 404, { ok: false, error: 'no such page in the workshop' });
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const mime =
        ext === '.html'
          ? 'text/html; charset=utf-8'
          : ext === '.js'
            ? 'text/javascript; charset=utf-8'
            : ext === '.css'
              ? 'text/css; charset=utf-8'
              : ext === '.json'
                ? 'application/json; charset=utf-8'
                : ext === '.svg'
                  ? 'image/svg+xml'
                  : ext === '.png'
                    ? 'image/png'
                    : 'text/plain; charset=utf-8';
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': mime,
        'cache-control': 'no-cache',
        'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups',
        'x-content-type-options': 'nosniff',
        'content-length': body.length,
      });
      res.end(body);
      return;
    }

    if (serveStatic(path.join(ROOT, 'src', 'viewer'), p, res, fs, path, { cfg })) return;

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[world] request failed', err);
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

process.on('SIGINT', () => {
  console.log('\n[world] saving and stopping');
  try {
    save();
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});
process.on('SIGTERM', () => {
  try {
    save();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`[world] ${cfg.town.name} is running on http://localhost:${cfg.port}`);
  console.log(`[world] admin panel: /admin (token: ${adminToken(cfg)})`);
  console.log(`[world] day ${state.clock.day}, ${timeLabel(state)} — ${state.weather.kind}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[world] port ${cfg.port} is already in use. Stop the other copy or set PORT.`);
    process.exit(1);
  }
  console.error('[world] server error', err);
});
