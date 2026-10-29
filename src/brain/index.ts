import { loadConfig } from '../config.ts';
import { clamp, oneLine } from '../util/text.ts';
import { describeNeedsValues, energyBand, moodBand } from '../world/needs.ts';
import { Brain, sleep } from './llm.ts';
import { loadMemory, consolidate } from './memory.ts';
import { evolvePersona, loadPersona, personaBrief, type PersonaSheet } from './persona.ts';
import { appendLog, gc, hasDiary, readLog, writeDiaryEntry } from './diary.ts';
import { browseSession } from './browse.ts';
import { reflexDecision, type Decision } from './reflex.ts';
import type { InspectionVerdict, ModelDecision, Observation } from './types.ts';

const cfg = loadConfig();
const brain = new Brain(cfg);
const memory = loadMemory(cfg);
let persona: { baseline: PersonaSheet; current: PersonaSheet } = loadPersona(cfg);

const BASE = `http://127.0.0.1:${cfg.port}`;
const NAME = cfg.creature.name;

let lastEventId = 0;
let lastFinishedHandled = 0;
let lastObs: Observation | null = null;
let firstBeat = true;
let heartbeat = cfg.brain.heartbeatMaxMs;
let workingMemory: string[] = [];
let lastDay = 0;
let lastDiaryDay = 0;
let decisions = 0;
let lastDecisionAt = 0;
let worldDownLogged = false;
let quietBeats = 0;

function brief(): string {
  return personaBrief(persona.current);
}

/** "The Wet Feather" reads as "the Wet Feather" mid-sentence. */
function inlineName(name: string | undefined): string {
  if (!name) return 'somewhere in town';
  const lowered = name.replace(/^The\s+/i, 'the ');
  return /^the\s/i.test(lowered) ? lowered : `the ${lowered}`;
}

function log(msg: string): void {
  console.log(`[brain] ${msg}`);
}

async function observe(): Promise<Observation | null> {
  try {
    const res = await fetch(`${BASE}/api/observe?since=${lastEventId}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const obs = (await res.json()) as Observation;
    for (const e of obs.events ?? []) lastEventId = Math.max(lastEventId, e.id);
    worldDownLogged = false;
    return obs;
  } catch (err) {
    if (!worldDownLogged) {
      log(`cannot reach the world (${(err as Error).message}); waiting for it`);
      worldDownLogged = true;
    }
    return null;
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: (err as Error).message } };
  }
}

// ---------------------------------------------------------------- memory of the moment

function remember(thought: string): void {
  workingMemory.push(thought);
  if (workingMemory.length > 8) workingMemory.shift();
}

function workingDigest(): string {
  return workingMemory.length ? workingMemory.map((w) => `- ${w}`).join('\n') : '(nothing on his mind)';
}

// ---------------------------------------------------------------- offering judgement

const judgementAttempts = new Map<string, { n: number; lastAt: number }>();

async function judgeOfferings(obs: Observation): Promise<void> {
  for (const item of obs.pendingInspection.slice(0, 2)) {
    const prior = judgementAttempts.get(item.id) ?? { n: 0, lastAt: 0 };
    // a failure must never become a loop that eats the whole daily budget
    if (prior.n >= 3) continue;
    if (prior.n > 0 && Date.now() - prior.lastAt < 90_000) continue;
    if (brain.coolingDown || brain.report().exhausted) return;
    judgementAttempts.set(item.id, { n: prior.n + 1, lastAt: Date.now() });
    const images = item.imagePath ? [{ path: item.imagePath, mime: item.imageMime ?? 'image/png' }] : [];
    const res = await brain.json<InspectionVerdict>({
      system:
        `${brief()}\n\nSomebody left something in Fenwick for you. You have just walked up to it and crouched down. ` +
        'You did not ask for it. You are allowed to keep it or to leave it where it is, and you do not have to be polite. ' +
        'A vision model is looking at the picture, not you — describe only what you actually see in it once it is described to you.',
      user: [
        `Day ${obs.day}, ${obs.time}. You are near ${inlineName(obs.place?.name)}.`,
        `Left by: ${item.from}`,
        item.text ? `They wrote: "${item.text}"` : 'There is no writing on it.',
        images.length ? 'There is a picture with it. Look at it before you decide.' : '',
        '',
        'Decide in character. Be honest: if it is insincere, say so and let it go. If it lands, keep it and it becomes part of the town.',
        'Reply with JSON only:',
        '{"keep":true,"feeling":0.6,"verdict":"what you think of it, one or two flat sentences, in your voice","reply":"what you would say to this person if they were standing there, under 30 words"}',
        'feeling is -1 to 1.',
      ]
        .filter(Boolean)
        .join('\n'),
      model: images.length ? 'vision' : 'quality',
      images,
      json: true,
      maxTokens: 500,
      temperature: 0.9,
    });

    if (!res.ok || !res.data) {
      log(`could not judge the offering from ${item.from}: ${res.error}. Leaving it where it is.`);
      if (prior.n + 1 >= 3) log(`giving up on that one for now; he will look again after a restart`);
      continue;
    }
    judgementAttempts.delete(item.id);
    const v = res.data;
    const keep = Boolean(v.keep);
    const verdict = String(v.verdict ?? '').slice(0, 600);
    const reply = String(v.reply ?? '').slice(0, 400);
    await post('/api/verdict', {
      offeringId: item.id,
      keep,
      verdict,
      reply,
      feeling: typeof v.feeling === 'number' ? clamp(v.feeling, -1, 1) : 0,
    });

    if (keep) {
      const added = memory.add(
        'people',
        `${item.from} left me ${item.text ? `"${oneLine(item.text, 90)}"` : 'a picture'} and I kept it. ${verdict}`,
        { strength: 0.85, day: obs.day },
      );
      if (!added.ok) log(`memory refused the offering note (${added.reason})`);
      workingMemory.push(`kept what ${item.from} left: ${verdict}`);
      log(`kept the offering from ${item.from}`);
    } else {
      workingMemory.push(`let go of what ${item.from} left`);
      log(`let go of the offering from ${item.from}`);
    }
    appendLog(cfg, obs.day, `[${obs.time}] offering from ${item.from}: ${keep ? 'KEPT' : 'released'} — ${verdict}`);
  }
}

// ---------------------------------------------------------------- deciding

function rutBans(obs: Observation): Set<string> {
  const bans = new Set<string>();
  const recent = obs.routine?.recent ?? [];
  const counts = new Map<string, number>();
  for (const r of recent) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const [id, n] of counts) {
    // travel is guarded per place instead: banning "go_to" outright would strand him
    if (id !== 'go_to' && n >= 3) bans.add(id);
  }
  return bans;
}

function bannedPlaces(obs: Observation): Set<string> {
  const out = new Set<string>();
  for (const [place, n] of Object.entries(obs.routine?.visitedToday ?? {})) {
    if (n >= 4) out.add(place);
  }
  return out;
}

function optionsBlock(obs: Observation, bans: Set<string>, placeBans: Set<string>): string {
  const allowed = (o: Observation['available'][number]) => {
    if (bans.has(o.id) && o.id !== 'eat' && o.id !== 'sleep') return false;
    if (o.id === 'go_to' && placeBans.has(String(o.args.place ?? ''))) return false;
    return true;
  };
  let opts = obs.available.filter(allowed);
  // never hand him an empty list: if the guards would silence everything, let him act
  if (!opts.length) opts = obs.available.slice();
  opts = opts.sort((a, b) => b.pull - a.pull).slice(0, 20);
  if (!opts.length) return '(nothing is available, which should not be able to happen)';
  return opts
    .map((o) => `- ${o.description}  →  {"action":"${o.id}"${Object.keys(o.args).length ? `,"args":${JSON.stringify(o.args)}` : ''}}  [pull ${o.pull.toFixed(2)}]`)
    .join('\n');
}

function tierFor(obs: Observation): 'quality' | 'fast' {
  const notable =
    (obs.stats?.keptTotal ?? 0) !== lastKeptTotal ||
    lastObs === null ||
    Math.abs(obs.creature.mood.valence) > 0.62 ||
    obs.creature.needs.curiosity > 0.78 ||
    obs.offeringCrystals.length > 0 ||
    (lastObs && lastObs.day !== obs.day);
  return notable ? 'quality' : 'fast';
}

let lastKeptTotal = 0;

async function decide(obs: Observation): Promise<{ decision: Decision; tier: string }> {
  const bans = rutBans(obs);
  const placeBans = bannedPlaces(obs);
  const tier = tierFor(obs);

  if (!brain.keyPresent) {
    return { decision: reflexDecision(obs), tier: 'reflex (no api key)' };
  }
  if (brain.report().exhausted) {
    return { decision: reflexDecision(obs), tier: 'reflex (daily budget spent)' };
  }
  if (brain.coolingDown) {
    return { decision: reflexDecision(obs), tier: 'reflex (rate limited)' };
  }

  const needsLine = describeNeedsValues(obs.creature.needs);
  const moodLine = `${moodBand(obs.creature.mood.valence)}, ${energyBand(obs.creature.mood.energy)}`;
  const finished = obs.lastFinished && obs.lastFinished.finishedAt > lastFinishedHandled ? obs.lastFinished.id : null;

  const prompt = [
    `Day ${obs.day}, ${obs.time}. Weather: ${obs.weather}. ${obs.night ? 'It is night.' : ''}`,
    obs.place ? `You are at ${inlineName(obs.place.name)} — ${obs.place.blurb}.` : 'You are standing in the street between places.',
    '',
    `BODY: ${needsLine}.`,
    `MOOD: ${moodLine}.`,
    `CARRYING: ${obs.creature.inventory.food} food, ${obs.creature.inventory.coins} coins.`,
    finished ? `YOU JUST FINISHED: ${finished}.` : '',
    obs.creature.action ? `YOU ARE CURRENTLY: ${obs.creature.action.label}.` : '',
    workingMemory.length ? `WHAT YOU WERE JUST THINKING:\n${workingDigest()}` : '',
    '',
    'WHAT YOU REMEMBER:',
    memory.digest(obs.day, 18),
    '',
    obs.events.length ? `WHAT JUST HAPPENED:\n${obs.events.map((e) => `- ${e.text}`).join('\n')}` : '',
    obs.offeringCrystals.length
      ? `SOMETHING IS OUT THERE:\n${obs.offeringCrystals
          .map((c) => `- a crystal from ${c.from}, about ${c.distance} tiles away, ${c.state}`)
          .join('\n')}`
      : '',
    '',
    'WHAT YOU CAN DO RIGHT NOW — pick exactly one, by its exact action id:',
    optionsBlock(obs, bans, placeBans),
    '',
    bans.size
      ? `You have been doing these too much today: ${[...bans].join(', ')}. Not again right now.`
      : '',
    placeBans.size ? `You have already been to: ${[...placeBans].join(', ')} several times today.` : '',
    '',
    'Decide what you do next. You are not answering a question and nobody is listening. Do not describe the scene.',
    'Reply with JSON only:',
    '{"action":"exact_id","args":{},"reason":"one short clause, why, in your own terms","thought":"what goes through your head, first person, under 20 words"}',
  ]
    .filter((line) => line !== '')
    .join('\n');

  const res = await brain.json<ModelDecision>({
    system:
      `${brief()}\n\n` +
      'You live in Fenwick, a small town. This is not a game and you are not an assistant. You have a body that gets hungry and tired, ' +
      'a small amount of money, and about nine things you know how to do. You cannot do anything that is not on the list of what you can do right now. ' +
      'Nobody is watching you and there is no audience to perform for. Choose the thing you actually want to do, not the thing that makes a good story. ' +
      'Most of what you do is ordinary.',
    user: prompt,
    model: tier,
    json: true,
    maxTokens: 400,
    temperature: 1.0,
  });

  if (!res.ok || !res.data?.action) {
    log(`model produced nothing usable (${res.error ?? 'no action'}), falling back to reflex`);
    const decision = reflexDecision(obs);
    return { decision, tier: `${tier} → reflex fallback` };
  }

  const proposed: Decision = {
    id: String(res.data.action),
    args: (res.data.args ?? {}) as Record<string, unknown>,
    reason: String(res.data.reason ?? '').slice(0, 200) || 'because',
    thought: String(res.data.thought ?? '').slice(0, 200) || 'fine.',
    via: 'model',
  };
  return { decision: proposed, tier };
}

function validate(obs: Observation, decision: Decision): { ok: boolean; error?: string } {
  const bans = rutBans(obs);
  const placeBans = bannedPlaces(obs);
  const essential = decision.id === 'eat' || decision.id === 'sleep';
  if (bans.has(decision.id) && !essential) {
    return { ok: false, error: `${decision.id} is what he keeps doing; blocked by the repetition guard` };
  }
  if (decision.id === 'go_to' && placeBans.has(String(decision.args.place ?? ''))) {
    return { ok: false, error: `he has been to that place too many times today` };
  }
  const match = obs.available.find((o) => {
    if (o.id !== decision.id) return false;
    if (decision.id === 'go_to') return String(o.args.place ?? '') === String(decision.args.place ?? '');
    if (decision.id === 'inspect') return String(o.args.offering ?? '') === String(decision.args.offering ?? '');
    return true;
  });
  if (!match) return { ok: false, error: `"${decision.id}" is not something he can do here` };
  return { ok: true };
}

// ---------------------------------------------------------------- day boundary work

async function dayBoundary(obs: Observation): Promise<void> {
  const endedDay = obs.day - 1;
  if (lastDiaryDay < endedDay && hasDiary(cfg, endedDay) === false) {
    const logText = readLog(cfg, endedDay);
    const canThink = brain.keyPresent && !brain.report().exhausted && !brain.coolingDown;
    if (logText.trim() && canThink) {
      const entry = await writeDiaryEntry({
        cfg,
        brain,
        day: endedDay,
        personaBrief: brief(),
        memoryDigest: memory.digest(endedDay, 18),
        logText,
      });
      // whether it worked or not, do not try again this settlement: a failed
      // diary must not turn into a call every heartbeat
      lastDiaryDay = endedDay;
      if (entry.ok) log(`wrote the diary for day ${endedDay}: "${oneLine(entry.text, 80)}"`);
      else log(`could not write the diary for day ${endedDay}: ${entry.error}`);
    } else {
      lastDiaryDay = endedDay;
      if (logText.trim()) log(`day ${endedDay} went unwritten (no brain available to write it)`);
    }
  }
  memory.decay(obs.day);
  gc(cfg, obs.day);
}

async function consolidateNow(obs: Observation, why: string): Promise<void> {
  const logText = readLog(cfg, obs.day);
  if (!logText.trim()) return;
  if (!brain.keyPresent || brain.report().exhausted || brain.coolingDown) {
    log('would consolidate but there is no model available; he keeps the day as it is');
    return;
  }
  log(`consolidating memory (${why})`);
  const result = await consolidate({
    cfg,
    brain,
    memory,
    persona: persona.current,
    day: obs.day,
    logText,
    personaBrief: brief(),
  });
  if (!result.ok) {
    log(`consolidation failed: ${result.error}`);
    return;
  }
  log(`memory rewritten — ${result.applied.length} changes`);
  const evolution = result.result?.evolution;
  if (evolution && (evolution.traits?.length || evolution.values?.length || evolution.fears?.length || evolution.quirks?.length)) {
    persona.current = evolvePersona(cfg, persona.baseline, persona.current, {
      traits: evolution.traits,
      values: evolution.values,
      fears: evolution.fears,
      quirks: evolution.quirks,
      note: result.result?.note,
    });
    log(`something about him changed: ${persona.current.traits.filter((t) => !persona.baseline.traits.includes(t)).join(', ') || 'no new traits'}`);
  } else if (result.result?.note) {
    persona.current = evolvePersona(cfg, persona.baseline, persona.current, { note: result.result.note });
  }
}

async function handleFinished(obs: Observation): Promise<void> {
  const finished = obs.lastFinished;
  if (!finished || finished.finishedAt <= lastFinishedHandled) return;
  lastFinishedHandled = finished.finishedAt;

  appendLog(cfg, obs.day, `[${obs.time}] finished ${finished.id}${finished.args?.place ? ` at ${finished.args.place}` : ''}`);

  if (finished.id === 'browse' && cfg.browse.enabled) {
    log('he is browsing the internet');
    const outcome = await browseSession({ cfg, brain, day: obs.day, personaBrief: brief(), memoryDigest: memory.digest(obs.day, 12) });
    if (outcome.reading) {
      const r = outcome.reading;
      log(`read "${oneLine(r.title, 60)}" — opinion ${r.opinion.toFixed(2)}`);
      memory.add('facts', `I read about ${r.tags.join(' / ') || r.title}: ${oneLine(r.summary, 140)}`, {
        strength: 0.5,
        day: obs.day,
      });
      if (Math.abs(r.opinion) > 0.45) {
        memory.add('opinions', `${r.title.slice(0, 80)} — ${oneLine(r.summary, 150)} (${r.opinion > 0 ? 'I liked it' : 'I did not'})`, {
          strength: 0.45 + Math.abs(r.opinion) * 0.3,
          day: obs.day,
        });
      }
      await post('/api/reading', { url: r.url, title: r.title, opinion: r.summary, tags: r.tags });
    } else {
      log(`browsing came to nothing: ${outcome.error}`);
      appendLog(cfg, obs.day, `[${obs.time}] browsing failed: ${outcome.error}`);
    }
  }

  if (finished.id === 'write_diary') {
    const entry = await writeDiaryEntry({
      cfg,
      brain,
      day: obs.day,
      personaBrief: brief(),
      memoryDigest: memory.digest(obs.day, 14),
      logText: readLog(cfg, obs.day),
      forced: true,
    });
    if (entry.ok) log(`wrote a diary entry in the middle of the day`);
  }

  if (finished.id === 'sleep') {
    await consolidateNow(obs, 'woke up');
  }
}

// ---------------------------------------------------------------- one beat

async function beat(): Promise<void> {
  const obs = await observe();
  if (!obs) {
    heartbeat = Math.max(heartbeat, 5000);
    return;
  }

  if (firstBeat) {
    firstBeat = false;
    // do not re-run work that finished before the last restart
    lastFinishedHandled = obs.lastFinished?.finishedAt ?? 0;
  }

  if (lastDay === 0) {
    lastDay = obs.day;
    lastDiaryDay = obs.day - 1;
    log(`${NAME} is alive. day ${obs.day} ${obs.time}, ${obs.weather}. ${brain.keyPresent ? 'brain: model' : 'brain: reflex only (no API key)'}`);
  } else if (obs.day !== lastDay) {
    lastDay = obs.day;
    await dayBoundary(obs);
  }

  if (obs.pendingInspection.length) {
    await judgeOfferings(obs);
    lastObs = obs;
    heartbeat = cfg.brain.heartbeatMinMs;
    return;
  }
  judgementAttempts.clear();

  await handleFinished(obs);

  const remaining = obs.creature.action?.remainingMs ?? 0;
  const idle = !obs.creature.action;

  // nothing to decide: he is in the middle of something. He finishes what he is
  // doing — the world has no concept of dropping a task half-way, so trying to
  // decide now would only get refused.
  if (!idle && !obs.creature.asleep) {
    quietBeats++;
    lastObs = obs;
    adapt(obs, true);
    return;
  }

  if (obs.creature.asleep) {
    lastObs = obs;
    heartbeat = 20_000;
    return;
  }

  const startedAt = Date.now();
  const { decision, tier } = await decide(obs);
  lastKeptTotal = obs.stats?.keptTotal ?? lastKeptTotal;
  const check = validate(obs, decision);
  let final = decision;
  if (!check.ok) {
    log(`blocked: ${check.error}`);
    appendLog(cfg, obs.day, `[${obs.time}] blocked: ${decision.id} — ${check.error}`);
    final = reflexDecision(obs);
  }

  const result = await post('/api/action', {
    id: final.id,
    args: final.args,
    reason: final.reason,
    thought: final.thought,
  });

  if (!result.ok) {
    log(`the world refused ${final.id}: ${result.data?.error ?? result.status}`);
    appendLog(cfg, obs.day, `[${obs.time}] world refused ${final.id}: ${result.data?.error ?? result.status}`);
    lastObs = obs;
    adapt(obs, false);
    return;
  }

  decisions++;
  lastDecisionAt = Date.now();
  remember(`${obs.time}: ${final.thought}`);
  obs.creature.moodNote = final.thought;
  appendLog(
    cfg,
    obs.day,
    `[${obs.time}] ${final.id}${final.args?.place ? ` ${final.args.place}` : ''} — ${final.reason}${final.via === 'reflex' ? ' (reflex)' : ''}`,
  );
  for (const e of obs.events) appendLog(cfg, obs.day, `  · ${e.text}`);
  log(`${obs.time} ${final.id}${final.args?.place ? ` → ${final.args.place}` : ''} — ${final.reason} [${tier}, ${Date.now() - startedAt}ms]`);

  lastObs = obs;
  adapt(obs, false);
}

function adapt(obs: Observation, waiting: boolean): void {
  const energy = obs.creature.mood.energy;
  const agitation = Math.abs(obs.creature.mood.valence);
  const busyness = clamp(energy * 0.6 + agitation * 0.5, 0, 1);
  const target = cfg.brain.heartbeatMaxMs - busyness * (cfg.brain.heartbeatMaxMs - cfg.brain.heartbeatMinMs);
  if (waiting) {
    const actionLeft = obs.creature.action?.remainingMs ?? 0;
    heartbeat = clamp(Math.min(target, Math.max(4000, actionLeft * 0.35)), cfg.brain.heartbeatMinMs, cfg.brain.heartbeatMaxMs);
  } else {
    heartbeat = clamp(target, cfg.brain.heartbeatMinMs, cfg.brain.heartbeatMaxMs);
  }
}

async function main(): Promise<void> {
  log(`starting. provider=${cfg.brain.provider} model=${cfg.brain.model} budget=${cfg.brain.maxCallsPerDay}/day`);
  if (!brain.keyPresent) {
    log('no API key found. He will live on reflexes until you add one to .env (see README).');
  }
  // wait for the world to come up
  for (let i = 0; i < 60; i++) {
    const obs = await observe();
    if (obs) {
      lastObs = obs;
      break;
    }
    await sleep(1000);
  }

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  while (!stopping) {
    try {
      await beat();
    } catch (err) {
      log(`beat failed: ${(err as Error).message}`);
      heartbeat = Math.max(heartbeat, 6000);
    }
    await sleep(heartbeat);
  }
  log('stopping');
  process.exit(0);
}

main().catch((err) => {
  console.error('[brain] fatal', err);
  process.exit(1);
});
