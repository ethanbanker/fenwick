import fs from 'node:fs';
import type { Config } from '../config.ts';
import type { Town } from './map.ts';
import { darkness, timeLabel, type WorldState } from './state.ts';
import { describeNeedsValues, energyBand, moodBand } from './needs.ts';
import { loadMemory, SECTIONS, type MemorySection } from '../brain/memory.ts';
import { loadPersona, personaDrift } from '../brain/persona.ts';
import { loadInterests, loadReadings, topInterests } from '../brain/browse.ts';
import { listDiary } from '../brain/diary.ts';

export type PageKind = 'diary' | 'memories' | 'mind' | 'offerings';

const CSS = `
:root{
  --bg:#14110f; --panel:#1d1916; --panel2:#241f1b; --line:#332b25;
  --ink:#efe6d8; --dim:#a8998a; --faint:#6f635a;
  --amber:#e2b45c; --amber-dim:#8a6c36; --green:#7d9b6a; --red:#b26a5a;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);
  font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--amber);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:940px;margin:0 auto;padding:28px 20px 80px}
nav{display:flex;gap:20px;align-items:baseline;flex-wrap:wrap;
  border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:28px}
nav .brand{font-family:ui-serif,Georgia,serif;font-size:19px;letter-spacing:.06em;color:var(--ink);margin-right:8px}
nav a{color:var(--dim);font-size:13px;letter-spacing:.09em;text-transform:uppercase}
nav a.on{color:var(--amber)}
h1{font-family:ui-serif,Georgia,serif;font-weight:500;font-size:30px;letter-spacing:.02em;margin:0 0 6px}
h2{font-family:ui-serif,Georgia,serif;font-weight:500;font-size:19px;margin:34px 0 10px;color:var(--ink)}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:22px 0 8px}
p{margin:0 0 14px}
.sub{color:var(--dim);font-size:13.5px;margin-bottom:26px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:16px}
.entry{background:var(--panel);border:1px solid var(--line);border-left:2px solid var(--amber-dim);
  border-radius:4px;padding:22px 24px;margin-bottom:18px}
.entry .day{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:12px}
.entry .body{font-family:ui-serif,Georgia,serif;font-size:17px;line-height:1.75;white-space:pre-wrap;color:#e9dfd0}
.meta{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--faint);
  letter-spacing:.05em;text-transform:uppercase;margin-bottom:22px}
.meta b{color:var(--dim);font-weight:500}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.slots{display:flex;gap:3px;flex-wrap:wrap;margin:6px 0 12px}
.slot{width:13px;height:22px;border-radius:2px;background:var(--panel2);border:1px solid var(--line)}
.bar{height:5px;background:var(--panel2);border-radius:3px;overflow:hidden;margin-top:6px}
.bar i{display:block;height:100%;background:var(--amber);opacity:.8}
ul{margin:0;padding-left:18px}
li{margin:0 0 5px}
.tag{display:inline-block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);
  border:1px solid var(--line);border-radius:999px;padding:2px 9px;margin:0 5px 5px 0}
.added{color:var(--green)}
.missing{color:var(--red);text-decoration:line-through;opacity:.7}
.dim{color:var(--dim);font-size:13.5px}
.faint{color:var(--faint);font-size:12px}
input,textarea,button,select{font:inherit;color:var(--ink);background:var(--panel2);
  border:1px solid var(--line);border-radius:8px;padding:10px 12px;width:100%}
textarea{min-height:120px;resize:vertical}
button{background:var(--amber);color:#20180c;border:none;font-weight:600;cursor:pointer;letter-spacing:.03em}
button:hover{filter:brightness(1.08)}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--dim)}
label{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);margin:16px 0 6px}
.row{display:flex;gap:14px;flex-wrap:wrap}
.row>*{flex:1;min-width:220px}
.crystal{display:flex;gap:14px;align-items:flex-start;padding:14px 0;border-bottom:1px solid var(--line)}
.crystal:last-child{border-bottom:none}
.crystal img{width:78px;height:78px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
.pill{display:inline-block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  padding:2px 9px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.pill.kept{color:#cfe0bd;border-color:#4d5f3f;background:#232b1d}
.pill.released{color:#d9b1a6;border-color:#5b3b33;background:#2a2020}
.pill.waiting{color:var(--amber);border-color:var(--amber-dim);background:#2a2318}
.empty{color:var(--faint);font-style:italic;font-family:ui-serif,Georgia,serif}
`;

function esc(s: string): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function mdLite(text: string): string {
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('### ')) return `<h3>${esc(t.slice(4))}</h3>`;
      if (t.startsWith('## ')) return `<h2>${esc(t.slice(3))}</h2>`;
      if (t.startsWith('# ')) return `<h1>${esc(t.slice(2))}</h1>`;
      if (/^[-*]\s/.test(t)) {
        const items = t
          .split('\n')
          .map((l) => l.replace(/^[-*]\s+/, '').trim())
          .filter(Boolean)
          .map((l) => `<li>${esc(l)}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${esc(t).replaceAll('\n', '<br>')}</p>`;
    })
    .join('\n');
}

function layout(kind: PageKind, cfg: Config, state: WorldState, body: string, subtitle: string): string {
  const nav: Array<[PageKind | 'town', string, string]> = [
    ['town', '/', 'the town'],
    ['diary', '/diary', 'diary'],
    ['memories', '/memories', 'memories'],
    ['mind', '/mind', 'mind'],
    ['offerings', '/offerings', 'offerings'],
  ];
  const night = darkness(state) > 0.5;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cfg.creature.name)} — ${esc(kind)}</title>
<style>${CSS}</style>
</head><body class="${night ? 'night' : ''}">
<div class="wrap">
  <nav>
    <span class="brand">${esc(cfg.creature.name)}</span>
    ${nav.map(([k, href, label]) => `<a href="${href}" class="${k === kind ? 'on' : ''}">${label}</a>`).join('')}
  </nav>
  <div class="sub">${subtitle}</div>
  ${body}
</div>
</body></html>`;
}

function statusLine(cfg: Config, state: WorldState): string {
  const c = state.creature;
  return `<div class="meta">
    <span><b>day ${state.clock.day}</b> ${timeLabel(state)}</span>
    <span><b>${esc(state.weather.kind)}</b></span>
    <span><b>${esc(cfg.town.name)}</b></span>
    <span>${esc(c.atPlace ?? 'in the street')}</span>
    <span>${esc(c.action?.label ?? 'nothing in particular')}</span>
  </div>`;
}

// ------------------------------------------------------------------ diary

function diaryPage(cfg: Config, state: WorldState): string {
  const entries = listDiary(cfg);
  const body = entries.length
    ? entries
        .slice(0, 40)
        .map(
          (e) => `<div class="entry">
        <div class="day">day ${e.day}</div>
        <div class="body">${esc(e.body.replace(/^#\s*day\s*\d+\s*/i, '').trim())}</div>
      </div>`,
        )
        .join('')
    : `<div class="card"><p class="empty">He has not written anything yet. He writes at the end of each day, or when a day gets too heavy to carry around.</p></div>`;

  return layout('diary', cfg, state, `${statusLine(cfg, state)}${body}`, `What ${esc(cfg.creature.name)} wrote down himself, unedited.`);
}

// ------------------------------------------------------------------ memories

function memoriesPage(cfg: Config, state: WorldState): string {
  const memory = loadMemory(cfg);
  const day = state.clock.day;
  const counts = memory.counts(day);
  const slots = cfg.memory.slotsPerSection;

  const sectionBlocks = SECTIONS.map((section: MemorySection) => {
    const bullets = memory.sectionBullets(section, day);
    const slotHtml: string[] = [];
    for (let i = 0; i < slots; i++) {
      const b = bullets[i];
      if (b) {
        const strength = memory.effective(b, day);
        slotHtml.push(
          `<div class="slot" title="${esc(b.text)}" style="background:rgba(226,180,92,${0.16 + strength * 0.74});border-color:rgba(226,180,92,${0.25 + strength * 0.4})"></div>`,
        );
      } else {
        slotHtml.push('<div class="slot"></div>');
      }
    }
    return `<div class="card">
      <h3>${section} — ${counts[section]}/${slots}</h3>
      <div class="slots">${slotHtml.join('')}</div>
      ${
        bullets.length
          ? `<ul>${bullets
              .slice(0, 10)
              .map((b) => `<li>${esc(b.text)} <span class="faint">${Math.round(memory.effective(b, day) * 100)}%</span></li>`)
              .join('')}</ul>`
          : '<p class="empty">empty</p>'
      }
    </div>`;
  }).join('');

  const all = memory.file.bullets
    .map((b) => ({ b, eff: memory.effective(b, day) }))
    .sort((x, y) => x.eff - y.eff)
    .slice(0, 6);

  const fading = all.length
    ? `<div class="card"><h3>closest to being lost</h3><ul>${all
        .map(({ b, eff }) => `<li>${esc(b.text)} <span class="faint">${Math.round(eff * 100)}% · ${b.section}</span></li>`)
        .join('')}</ul>
        <p class="faint">Strength halves every ${cfg.memory.halfLifeDays} days unless something reinforces it.</p></div>`
    : '';

  return layout(
    'memories',
    cfg,
    state,
    `${statusLine(cfg, state)}
     <div class="meta"><span><b>${memory.file.bullets.length}</b> memories held</span>
     <span><b>${slots}</b> slots per section</span>
     <span><b>${cfg.memory.halfLifeDays}</b> day half-life</span></div>
     ${fading}
     ${sectionBlocks}
     ${
       memory.file.skills.length || memory.file.tools.length
         ? `<h2>worked out along the way</h2>
            ${memory.file.skills.length ? `<div class="card"><h3>skills</h3><ul>${memory.file.skills.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
            ${memory.file.tools.length ? `<div class="card"><h3>tools</h3><ul>${memory.file.tools.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}`
         : ''
     }`,
    'What he is carrying, and what it costs him to carry it. Memory is finite and competitive: something has to be pushed out to make room.',
  );
}

// ------------------------------------------------------------------ mind

function mindPage(cfg: Config, state: WorldState): string {
  const { baseline, current } = loadPersona(cfg);
  const drift = personaDrift(baseline, current);
  const interests = loadInterests(cfg);
  const readings = loadReadings(cfg).slice(-12).reverse();
  const top = topInterests(interests, 12);
  const c = state.creature;

  let budget = { calls: 0 };
  try {
    budget = JSON.parse(fs.readFileSync(`${cfg.dataDir}/brain/budget.json`, 'utf8'));
  } catch {
    /* no budget file yet */
  }

  const traitList = current.traits
    .map((t) => {
      const added = drift.addedTraits.some((a) => a.toLowerCase() === t.toLowerCase());
      return `<li class="${added ? 'added' : ''}">${esc(t)}${added ? ' <span class="faint">— learned</span>' : ''}</li>`;
    })
    .join('');

  const body = `
  ${statusLine(cfg, state)}
  <div class="meta">
    <span>mood <b>${moodBand(c.mood.valence)}</b></span>
    <span>energy <b>${energyBand(c.mood.energy)}</b></span>
    <span>${esc(describeNeedsValues(c.needs))}</span>
  </div>

  <div class="card">
    <h3>who he says he is right now</h3>
    <p>${esc(current.backstory)}</p>
    <h3>traits</h3>
    <ul>${traitList}</ul>
    ${drift.removedTraits.length ? `<p class="faint">drifted away from: <span class="missing">${drift.removedTraits.map(esc).join(', ')}</span></p>` : ''}
    <p class="faint">The baseline sheet is immutable. He may add at most two traits and drop none of the rest, so the drift stays a change rather than a replacement.</p>
  </div>

  <div class="card">
    <h3>voice</h3>
    <p class="dim">${esc(current.voice)}</p>
    <h3>values</h3>
    <ul>${current.values.map((v) => `<li class="${drift.extraValues.includes(v) ? 'added' : ''}">${esc(v)}</li>`).join('')}</ul>
    <h3>fears</h3>
    <ul>${current.fears.map((v) => `<li class="${drift.extraFears.includes(v) ? 'added' : ''}">${esc(v)}</li>`).join('')}</ul>
    <h3>quirks</h3>
    <ul>${current.quirks.map((v) => `<li class="${drift.extraQuirks.includes(v) ? 'added' : ''}">${esc(v)}</li>`).join('')}</ul>
    ${
      drift.notes.length
        ? `<h3>in his own words, lately</h3><ul>${drift.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
        : '<p class="faint">He has not written anything about himself yet.</p>'
    }
  </div>

  <div class="card">
    <h3>what he has been reading</h3>
    ${
      top.length
        ? top.map((t) => `<span class="tag">${esc(t)}</span>`).join('')
        : '<p class="empty">Nothing yet. He has not been on the internet.</p>'
    }
    ${
      readings.length
        ? `<ul style="margin-top:14px">${readings
            .slice(0, 8)
            .map(
              (r) =>
                `<li><a href="${esc(r.url)}" rel="noreferrer noopener" target="_blank">${esc(r.title)}</a> <span class="faint">${r.opinion > 0 ? 'liked' : r.opinion < 0 ? 'did not like' : 'shrugged'} · day ${r.day}</span><br><span class="dim">${esc(r.summary)}</span></li>`,
            )
            .join('')}</ul>`
        : ''
    }
  </div>

  <div class="card">
    <h3>model budget</h3>
    <p class="dim">${budget.calls ?? 0} of ${cfg.brain.maxCallsPerDay} calls used today. When it runs out he keeps living on reflexes: he still moves, eats, sleeps and answers offers, he just stops deliberating.</p>
    <div class="bar"><i style="width:${Math.min(100, ((budget.calls ?? 0) / cfg.brain.maxCallsPerDay) * 100)}%"></i></div>
  </div>`;

  return layout('mind', cfg, state, body, 'His authored self next to what he has written about himself since. The drift is the point.');
}

// ------------------------------------------------------------------ offerings

function offeringsPage(cfg: Config, state: WorldState): string {
  const mine = state.offerings.slice().reverse();
  const standing = (from: string) => {
    const kept = state.offerings.filter((o) => o.kept && o.from === from).length;
    return kept >= 10 ? 'one of his own' : kept >= 3 ? 'a familiar face' : kept >= 1 ? 'someone he knows' : 'a new face';
  };
  const now = Date.now();
  const todayCount = state.offerings.filter((o) => o.createdAt > now - 86_400_000).length;

  const list = mine.length
    ? mine
        .slice(0, 30)
        .map((o) => {
          const statePill =
            o.state === 'kept'
              ? `<span class="pill kept">kept</span>`
              : o.state === 'released'
                ? `<span class="pill released">let it go</span>`
                : o.state === 'found'
                  ? `<span class="pill waiting">he is looking at it</span>`
                  : o.state === 'noticed'
                    ? `<span class="pill waiting">he noticed it</span>`
                    : `<span class="pill">waiting for him to find it</span>`;
          return `<div class="crystal">
            ${o.imagePath ? `<img src="/img/${esc(o.id)}" alt="">` : ''}
            <div style="flex:1">
              <div style="margin-bottom:6px">${statePill} <span class="faint">from ${esc(o.from)} · day ${state.offerings.indexOf(o) >= 0 ? '' : ''}</span></div>
              ${o.text ? `<p style="margin-bottom:8px">${esc(o.text)}</p>` : ''}
              ${o.verdict ? `<p class="dim"><b>${esc(cfg.creature.name)}:</b> ${esc(o.verdict)}</p>` : ''}
              ${o.replies.length ? `<p class="dim">${esc(o.replies[o.replies.length - 1])}</p>` : ''}
            </div>
          </div>`;
        })
        .join('')
    : `<p class="empty">Nothing has been left for him yet.</p>`;

  const body = `
  ${statusLine(cfg, state)}
  <div class="card">
    <p>Leave him something, words or a picture. It does not go into an inbox — a crystal appears somewhere in the town and he has to come across it. His sense range is smaller than the ring it spawns in, so it might take him a while, and it might depend on what mood he is in.</p>
    <p class="faint">He decides whether to keep it. Nothing you can do buys standing with him except things he actually decides to keep. ${todayCount} left in the last day; he will only tolerate so many at once.</p>
    <div id="form">
      <label for="from">your name</label>
      <input id="from" placeholder="who is leaving this" maxlength="40">
      <label for="text">what you want to say to him</label>
      <textarea id="text" maxlength="1600" placeholder="He does not like insincerity."></textarea>
      <label for="image">or a picture (optional, 4MB max)</label>
      <input id="image" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <div style="margin-top:18px;display:flex;gap:12px;align-items:center">
        <button id="send" style="max-width:200px">leave it in the town</button>
        <span id="msg" class="faint"></span>
      </div>
    </div>
  </div>

  <h2>what he has been left</h2>
  <div class="card">${list}</div>

  <h2>standing</h2>
  <div class="card">
    <p class="dim">Earned only by things he decided to keep. Never bought.</p>
    <div class="meta">
      <span>kept in total <b>${state.keptTotal}</b></span>
      <span>left all time <b>${state.offerings.length}</b></span>
    </div>
    ${
      [...new Set(state.offerings.map((o) => o.from))]
        .map((f) => `<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0">
          <span>${esc(f)}</span><span class="dim">${esc(standing(f))} · ${state.offerings.filter((o) => o.kept && o.from === f).length} kept</span></div>`)
        .join('') || '<p class="empty">Nobody yet.</p>'
    }
  </div>

  <script>
  const send = document.getElementById('send');
  const msg = document.getElementById('msg');
  send.addEventListener('click', async () => {
    const from = document.getElementById('from').value.trim();
    const text = document.getElementById('text').value.trim();
    const file = document.getElementById('image').files[0];
    if (!text && !file) { msg.textContent = 'say something or attach a picture'; return; }
    msg.textContent = 'leaving it…';
    let imageBase64 = null, imageMime = null;
    if (file) {
      imageBase64 = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.readAsDataURL(file);
      });
      imageMime = file.type;
    }
    const res = await fetch('/api/offering', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ from: from || 'someone', text, imageBase64, imageMime })
    });
    const data = await res.json();
    if (data.ok) { msg.textContent = 'it is out there now. he will have to find it.'; setTimeout(() => location.reload(), 1200); }
    else msg.textContent = data.error || 'that did not work';
  });
  </script>`;

  return layout(
    'offerings',
    cfg,
    state,
    body,
    `Leave ${esc(cfg.creature.name)} something and he may keep it. He decides.`,
  );
}

export function renderPage(
  kind: PageKind,
  cfg: Config,
  state: WorldState,
  _town: Town,
  _url: URL,
): string {
  switch (kind) {
    case 'diary':
      return diaryPage(cfg, state);
    case 'memories':
      return memoriesPage(cfg, state);
    case 'mind':
      return mindPage(cfg, state);
    case 'offerings':
      return offeringsPage(cfg, state);
    default:
      return diaryPage(cfg, state);
  }
}
