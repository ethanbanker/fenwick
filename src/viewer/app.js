/* Fenwick viewer. A renderer and nothing else: no simulation state lives here.
   If you close this tab, his day carries on. */
(() => {
  'use strict';

  const TW = 32;
  const TH = 16;
  const CREATURE = '__CREATURE__';

  const canvas = document.getElementById('view');
  const view = canvas.getContext('2d', { alpha: false });
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d', { alpha: false });

  let scale = 3;
  let baseW = 1;
  let baseH = 1;
  let dpr = Math.min(2, window.devicePixelRatio || 1);

  let town = null;
  let snap = null;
  let prevSnap = null;
  let stateAt = 0;

  // displayed creature position, smoothed toward the server's truth
  const shown = { x: 17, y: 20, dir: 's', initialized: false };
  const cam = { x: 17, y: 20, initialized: false };
  const drag = { active: false, x: 0, y: 0, ox: 0, oy: 0 };

  const events = [];
  const seenEvents = new Set();
  let lastThought = '';

  // ---------------------------------------------------------------- setup

  function resize() {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    const px = scale * dpr;
    baseW = Math.max(80, Math.ceil(canvas.width / px));
    baseH = Math.max(60, Math.ceil(canvas.height / px));
    base.width = baseW;
    base.height = baseH;
    bctx.imageSmoothingEnabled = false;
    view.imageSmoothingEnabled = false;
  }

  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- data

  fetch('/api/town')
    .then((r) => r.json())
    .then((t) => {
      town = t;
      if (!shown.initialized) {
        shown.x = t.spawn.x;
        shown.y = t.spawn.y;
        cam.x = shown.x;
        cam.y = shown.y;
      }
    })
    .catch(() => {});

  const es = new EventSource('/events');
  es.addEventListener('hello', (e) => {
    try {
      const data = JSON.parse(e.data);
      applyState(data.state);
    } catch {}
  });
  es.addEventListener('state', (e) => {
    try {
      applyState(JSON.parse(e.data));
    } catch {}
  });

  function applyState(next) {
    if (!next || !next.creature) return;
    prevSnap = snap;
    snap = next;
    stateAt = performance.now();
    lastThought = next.creature.action && next.creature.action.thought ? next.creature.action.thought : lastThought;
    if (!shown.initialized) {
      shown.x = next.creature.x;
      shown.y = next.creature.y;
      shown.initialized = true;
    }
    for (const ev of next.events || []) {
      if (seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      events.unshift(ev);
    }
    while (events.length > 6) events.pop();
    updateHud(next);
  }

  // ---------------------------------------------------------------- hud

  const $ = (id) => document.getElementById(id);

  function band(v, cuts, labels) {
    for (let i = 0; i < cuts.length; i++) if (v < cuts[i]) return labels[i];
    return labels[labels.length - 1];
  }

  function updateHud(s) {
    $('day').textContent = String(s.day);
    $('time').textContent = s.time;
    $('weather').textContent = s.weather;
    $('place').textContent = s.creature.atPlace ? placeName(s.creature.atPlace) : 'the street';

    for (const k of ['hunger', 'fatigue', 'curiosity', 'unease']) {
      const v = Math.round((s.creature.needs[k] || 0) * 100);
      const bar = $('n-' + k);
      const val = $('v-' + k);
      if (bar) bar.style.width = v + '%';
      if (val) val.textContent = String(v);
    }
    $('mood').textContent = band(s.creature.mood.valence, [-0.5, -0.15, 0.2, 0.55], ['low', 'flat', 'okay', 'good', 'bright']);
    $('energy').textContent = band(s.creature.mood.energy, [0.2, 0.5, 0.78], ['drowsy', 'calm', 'alert', 'wired']);
    const inv = s.creature.inventory || { food: 0, coins: 0, trinkets: 0 };
    $('kit-line').textContent = `carrying ${inv.food} food \u00b7 ${inv.coins} coins${inv.trinkets ? ` \u00b7 ${inv.trinkets} trinkets` : ''}`;
    const wantLine = $('want-line');
    if (wantLine) {
      wantLine.classList.toggle('on', Boolean(s.project?.text));
      wantLine.textContent = s.project?.text ? `wants to make ${s.project.text}` : '';
    }

    const label = s.creature.asleep
      ? 'asleep'
      : s.creature.action
        ? s.creature.action.label
        : s.creature.moving
          ? 'walking'
          : 'standing around';
    $('doing-label').textContent = label;
    $('doing').style.opacity = s.creature.asleep ? '0.55' : '1';
    $('doing-thought').textContent = s.creature.asleep ? '' : lastThought;

    const list = $('ticker-list');
    list.innerHTML = '';
    for (const ev of events.slice(0, 5)) {
      const li = document.createElement('li');
      li.textContent = ev.text;
      list.appendChild(li);
    }
  }

  function placeName(id) {
    if (!town) return id;
    const p = town.places.find((x) => x.id === id);
    return p ? p.name.toLowerCase() : id;
  }

  // ---------------------------------------------------------------- projection

  function project(x, y) {
    return {
      sx: (x - y) * (TW / 2) - (cam.x - cam.y) * (TW / 2) + baseW / 2,
      sy: (x + y) * (TH / 2) - (cam.x + cam.y) * (TH / 2) + baseH / 2 + 14,
    };
  }

  function hash(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  function poly(points, fill, stroke) {
    bctx.beginPath();
    bctx.moveTo(points[0].sx, points[0].sy);
    for (let i = 1; i < points.length; i++) bctx.lineTo(points[i].sx, points[i].sy);
    bctx.closePath();
    if (fill) {
      bctx.fillStyle = fill;
      bctx.fill();
    }
    if (stroke) {
      bctx.strokeStyle = stroke;
      bctx.lineWidth = 0.8;
      bctx.stroke();
    }
  }

  function lerpPt(a, b, t) {
    return { sx: a.sx + (b.sx - a.sx) * t, sy: a.sy + (b.sy - a.sy) * t };
  }

  // ---------------------------------------------------------------- ground

  const GROUND = {
    0: ['#69874f', '#63814a', '#6f8d55'], // grass
    1: ['#8b8171', '#847a6a', '#918776'], // road
    2: ['#3d6c79', '#43737f', '#396774'], // water
    3: ['#9a8f7d', '#948a78', '#a09583'], // plaza
    4: ['#4e4640', '#4e4640', '#4e4640'], // under buildings
    5: ['#69874f', '#63814a', '#6f8d55'], // tree ground
    6: ['#7b756a', '#736d63', '#827c71'], // rubble
    7: ['#c2ad85', '#bba67e', '#c9b48c'], // sand
    8: ['#8a7757', '#837051', '#907d5c'], // dirt
  };

  function drawGround(t) {
    const tiles = town.tiles;
    const w = town.w;
    const h = town.h;
    const waterPhase = t * 0.9;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const type = tiles[y * w + x];
        const p0 = project(x, y);
        if (p0.sx < -TW * 2 || p0.sx > baseW + TW * 2 || p0.sy < -TH * 3 || p0.sy > baseH + TH * 4) continue;

        const p1 = project(x + 1, y);
        const p2 = project(x + 1, y + 1);
        const p3 = project(x, y + 1);
        const palette = GROUND[type] || GROUND[0];
        const r = hash(x, y);
        let color = palette[Math.floor(r * palette.length) % palette.length];

        if (type === 2) {
          const wave = Math.sin(waterPhase + (x + y) * 0.7) * 0.5 + 0.5;
          const mix = 0.12 + wave * 0.2;
          color = blend('#36626e', '#4e8493', mix);
        }
        poly([p0, p1, p2, p3], color);

        // a little surface texture, deterministic so it never crawls
        if (type === 1 && r > 0.72) {
          const c = project(x + 0.3 + r * 0.4, y + 0.3 + (r * 7 % 1) * 0.4);
          bctx.fillStyle = 'rgba(255,255,255,0.045)';
          bctx.fillRect(Math.round(c.sx), Math.round(c.sy), 2, 1);
        } else if (type === 0 && r > 0.9) {
          const c = project(x + 0.5, y + 0.5);
          bctx.fillStyle = 'rgba(120,150,90,0.35)';
          bctx.fillRect(Math.round(c.sx) - 1, Math.round(c.sy) - 1, 1, 2);
        } else if (type === 3 && (x + y) % 2 === 0) {
          bctx.fillStyle = 'rgba(0,0,0,0.045)';
          bctx.fillRect(Math.round(p0.sx + TW / 4), Math.round(p0.sy + TH / 4), TW / 2, 1);
        }
      }
    }
  }

  function blend(a, b, t) {
    const pa = hex(a);
    const pb = hex(b);
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return `rgb(${r},${g},${bl})`;
  }

  function hex(s) {
    const h = s.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function shade(color, amount) {
    const p = hex(color);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amount))));
    return `rgb(${f(p[0])},${f(p[1])},${f(p[2])})`;
  }

  // ---------------------------------------------------------------- buildings

  const litWindows = [];

  function drawBuilding(p, t) {
    const { x, y, w, h } = p.rect;
    const wallH = 21 + (w + h) * 0.8;
    const A = project(x, y);
    const B = project(x + w, y);
    const C = project(x + w, y + h);
    const D = project(x, y + h);
    const up = (pt, k) => ({ sx: pt.sx, sy: pt.sy - k });
    const u = (pt) => up(pt, wallH);

    // south-west face (facing left)
    const swCol = shade(p.palette.wall, -0.26);
    poly([D, C, u(C), u(D)], swCol, 'rgba(0,0,0,0.22)');
    // south-east face (facing right, catches more light)
    poly([B, C, u(C), u(B)], p.palette.wall, 'rgba(0,0,0,0.22)');
    // roof
    poly([u(A), u(B), u(C), u(D)], p.palette.roof, 'rgba(0,0,0,0.3)');

    // roof lip and shingle lines
    bctx.strokeStyle = 'rgba(0,0,0,0.16)';
    bctx.lineWidth = 0.7;
    for (let i = 1; i <= 2; i++) {
      const k = i / 3;
      const p1 = lerpPt(u(A), u(D), k);
      const p2 = lerpPt(u(B), u(C), k);
      bctx.beginPath();
      bctx.moveTo(p1.sx, p1.sy);
      bctx.lineTo(p2.sx, p2.sy);
      bctx.stroke();
    }

    // door on whichever visible face the door tile is nearest
    const isSouth = p.door.y >= y + h;
    const doorW = 0.26;
    const doorH = 13;
    if (isSouth) {
      const tt = Math.max(0.06, Math.min(0.94 - doorW, (p.door.x - x) / w));
      const d0 = lerpPt(D, C, tt);
      const d1 = lerpPt(D, C, tt + doorW);
      poly([d0, d1, up(d1, doorH), up(d0, doorH)], p.palette.trim, 'rgba(0,0,0,0.3)');
      poly([up(d0, doorH), up(d1, doorH), up(d1, doorH + 2), up(d0, doorH + 2)], shade(p.palette.trim, 0.18));
      litWindows.push({ x: (d0.sx + d1.sx) / 2, y: d0.sy - doorH / 2, r: 9, warm: 0.55 });
    } else {
      const tt = Math.max(0.06, Math.min(0.94 - doorW, (p.door.y - y) / h));
      const d0 = lerpPt(B, C, tt);
      const d1 = lerpPt(B, C, tt + doorW);
      poly([d0, d1, up(d1, doorH), up(d0, doorH)], p.palette.trim, 'rgba(0,0,0,0.3)');
      litWindows.push({ x: (d0.sx + d1.sx) / 2, y: d0.sy - doorH / 2, r: 8, warm: 0.45 });
    }

    // windows
    const winCount = Math.max(1, Math.floor(w / 2));
    for (let i = 0; i < winCount; i++) {
      const tt = (i + 1) / (winCount + 1);
      const w0 = lerpPt(D, C, tt - 0.055);
      const w1 = lerpPt(D, C, tt + 0.055);
      const top = 15;
      poly([w0, w1, up(w1, top + 9), up(w0, top + 9)], '#2b2823', 'rgba(0,0,0,0.3)');
      litWindows.push({ x: (w0.sx + w1.sx) / 2, y: w0.sy - top - 4, r: 11, warm: 0.75 });
    }
    for (let i = 0; i < winCount; i++) {
      const tt = (i + 1) / (winCount + 1);
      const w0 = lerpPt(B, C, tt - 0.055);
      const w1 = lerpPt(B, C, tt + 0.055);
      const top = 15;
      poly([w0, w1, up(w1, top + 9), up(w0, top + 9)], '#332e28', 'rgba(0,0,0,0.3)');
      litWindows.push({ x: (w0.sx + w1.sx) / 2, y: w0.sy - top - 4, r: 10, warm: 0.65 });
    }

    // chimney
    const centre = lerpPt(lerpPt(u(A), u(C), 0.5), lerpPt(u(B), u(D), 0.5), 0.5);
    bctx.fillStyle = shade(p.palette.trim, 0.05);
    bctx.fillRect(Math.round(centre.sx) + 4, Math.round(centre.sy) - 12, 5, 12);
    bctx.fillStyle = shade(p.palette.roof, -0.35);
    bctx.fillRect(Math.round(centre.sx) + 4, Math.round(centre.sy) - 14, 5, 2);
  }

  // ---------------------------------------------------------------- props

  const lampLights = [];

  function drawTree(pr, t) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    const sway = Math.sin(t * 1.1 + pr.x * 0.7 + pr.y) * 0.9;
    bctx.fillStyle = 'rgba(0,0,0,0.22)';
    bctx.beginPath();
    bctx.ellipse(c.sx, c.sy + 1, 7, 3, 0, 0, Math.PI * 2);
    bctx.fill();
    bctx.fillStyle = '#4a3524';
    bctx.fillRect(Math.round(c.sx) - 1, Math.round(c.sy) - 9, 2, 9);
    const greens = ['#4f7440', '#5c8249', '#456a39'];
    const r = hash(pr.x, pr.y);
    const blobs = [
      { dx: 0, dy: -15, rr: 6.5 },
      { dx: -4 + sway * 0.4, dy: -12, rr: 5 },
      { dx: 4 + sway * 0.4, dy: -12.5, rr: 4.6 },
      { dx: 0.5 + sway, dy: -20, rr: 4.4 },
    ];
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      bctx.fillStyle = greens[(i + Math.floor(r * 3)) % 3];
      bctx.beginPath();
      bctx.arc(c.sx + b.dx + sway * 0.5, c.sy + b.dy, b.rr, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  function drawLamp(pr, t) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    bctx.fillStyle = 'rgba(0,0,0,0.22)';
    bctx.fillRect(Math.round(c.sx) - 4, Math.round(c.sy) - 1, 9, 2);
    bctx.fillStyle = '#3a3733';
    bctx.fillRect(Math.round(c.sx) - 1, Math.round(c.sy) - 18, 2, 18);
    bctx.fillStyle = '#4a4640';
    bctx.fillRect(Math.round(c.sx) - 2, Math.round(c.sy) - 15, 4, 2);
    bctx.fillStyle = '#2f2c28';
    bctx.fillRect(Math.round(c.sx) - 3, Math.round(c.sy) - 23, 6, 5);
    lampLights.push({ x: c.sx, y: c.sy - 21, r: 30, flicker: 0.14 * Math.sin(t * 3 + pr.x) });
  }

  function drawBench(pr) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    bctx.fillStyle = 'rgba(0,0,0,0.2)';
    bctx.fillRect(Math.round(c.sx) - 6, Math.round(c.sy) - 1, 12, 2);
    bctx.fillStyle = '#6b4c33';
    bctx.fillRect(Math.round(c.sx) - 6, Math.round(c.sy) - 7, 12, 3);
    bctx.fillStyle = '#5a3f2b';
    bctx.fillRect(Math.round(c.sx) - 6, Math.round(c.sy) - 10, 12, 2);
    bctx.fillStyle = '#443026';
    bctx.fillRect(Math.round(c.sx) - 5, Math.round(c.sy) - 4, 2, 4);
    bctx.fillRect(Math.round(c.sx) + 3, Math.round(c.sy) - 4, 2, 4);
  }

  function drawFountain(pr, t) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    bctx.fillStyle = 'rgba(0,0,0,0.24)';
    bctx.beginPath();
    bctx.ellipse(c.sx, c.sy + 1, 13, 6, 0, 0, Math.PI * 2);
    bctx.fill();
    bctx.fillStyle = '#8d8478';
    bctx.beginPath();
    bctx.ellipse(c.sx, c.sy - 2, 12, 6, 0, 0, Math.PI * 2);
    bctx.fill();
    const wave = 0.15 + 0.12 * Math.sin(t * 2);
    bctx.fillStyle = blend('#39697a', '#5c94a4', wave);
    bctx.beginPath();
    bctx.ellipse(c.sx, c.sy - 3, 9, 4.4, 0, 0, Math.PI * 2);
    bctx.fill();
    bctx.fillStyle = '#9a9184';
    bctx.fillRect(Math.round(c.sx) - 1, Math.round(c.sy) - 14, 2, 11);
    bctx.fillStyle = '#b0a79a';
    bctx.fillRect(Math.round(c.sx) - 3, Math.round(c.sy) - 16, 6, 3);
    for (let i = 0; i < 3; i++) {
      const a = t * 1.6 + i * 2.1;
      bctx.fillStyle = 'rgba(180,215,225,0.5)';
      bctx.fillRect(Math.round(c.sx + Math.cos(a) * 4), Math.round(c.sy - 13 + Math.sin(a * 1.3) * 2), 1, 3);
    }
  }

  function drawPayphone(pr) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    bctx.fillStyle = 'rgba(0,0,0,0.2)';
    bctx.fillRect(Math.round(c.sx) - 4, Math.round(c.sy) - 1, 8, 2);
    bctx.fillStyle = '#3c3a36';
    bctx.fillRect(Math.round(c.sx) - 3, Math.round(c.sy) - 16, 6, 16);
    bctx.fillStyle = '#22201d';
    bctx.fillRect(Math.round(c.sx) - 2, Math.round(c.sy) - 14, 4, 5);
    bctx.fillStyle = '#8a8578';
    bctx.fillRect(Math.round(c.sx) - 3, Math.round(c.sy) - 18, 6, 2);
  }

  function drawCrate(pr) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    bctx.fillStyle = 'rgba(0,0,0,0.18)';
    bctx.fillRect(Math.round(c.sx) - 5, Math.round(c.sy) - 1, 10, 2);
    bctx.fillStyle = '#7a5a38';
    bctx.fillRect(Math.round(c.sx) - 5, Math.round(c.sy) - 10, 10, 10);
    bctx.fillStyle = '#8d6b46';
    bctx.fillRect(Math.round(c.sx) - 5, Math.round(c.sy) - 10, 10, 2);
    bctx.strokeStyle = '#5e4429';
    bctx.lineWidth = 0.7;
    bctx.beginPath();
    bctx.moveTo(c.sx - 5, c.sy - 5);
    bctx.lineTo(c.sx + 5, c.sy - 5);
    bctx.stroke();
  }

  function drawGrave(pr) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    bctx.fillStyle = 'rgba(0,0,0,0.18)';
    bctx.fillRect(Math.round(c.sx) - 5, Math.round(c.sy) - 1, 10, 2);
    bctx.fillStyle = '#8f8880';
    bctx.fillRect(Math.round(c.sx) - 4, Math.round(c.sy) - 12, 8, 12);
    bctx.fillStyle = '#a29a90';
    bctx.fillRect(Math.round(c.sx) - 3, Math.round(c.sy) - 14, 6, 3);
    bctx.fillStyle = 'rgba(60,55,50,0.5)';
    bctx.fillRect(Math.round(c.sx) - 2, Math.round(c.sy) - 9, 4, 1);
  }

  function drawFlower(pr, t) {
    const c = project(pr.x + 0.5, pr.y + 0.5);
    const sway = Math.sin(t * 2 + pr.x) * 0.6;
    const cols = ['#d8a7a0', '#e0c98a', '#b9c7a0'];
    bctx.fillStyle = cols[pr.variant % 3];
    bctx.fillRect(Math.round(c.sx + sway), Math.round(c.sy) - 3, 2, 2);
    bctx.fillStyle = '#5d7a48';
    bctx.fillRect(Math.round(c.sx + sway), Math.round(c.sy) - 1, 1, 1);
  }

  // ---------------------------------------------------------------- crystals

  function drawCrystal(off, t) {
    const c = project(off.x + 0.5, off.y + 0.5);
    const bob = Math.sin(t * 1.8 + off.x * 0.9) * 1.6;
    const y = c.sy - 2 + bob;
    const kept = off.state === 'kept';
    const baseCol = kept ? '#9fd3b4' : off.state === 'released' ? '#b06a5a' : '#e2b45c';

    if (!kept) {
      const g = bctx.createRadialGradient(c.sx, y - 8, 1, c.sx, y - 8, 22);
      g.addColorStop(0, 'rgba(226,180,92,0.42)');
      g.addColorStop(1, 'rgba(226,180,92,0)');
      bctx.fillStyle = g;
      bctx.beginPath();
      bctx.arc(c.sx, y - 8, 22, 0, Math.PI * 2);
      bctx.fill();
    }

    bctx.beginPath();
    bctx.moveTo(c.sx, y - 17);
    bctx.lineTo(c.sx + 5, y - 9);
    bctx.lineTo(c.sx, y - 1);
    bctx.lineTo(c.sx - 5, y - 9);
    bctx.closePath();
    bctx.fillStyle = baseCol;
    bctx.fill();
    bctx.strokeStyle = 'rgba(255,246,225,0.75)';
    bctx.lineWidth = 0.8;
    bctx.stroke();

    bctx.beginPath();
    bctx.moveTo(c.sx, y - 17);
    bctx.lineTo(c.sx - 5, y - 9);
    bctx.lineTo(c.sx, y - 1);
    bctx.closePath();
    bctx.fillStyle = 'rgba(255,255,255,0.22)';
    bctx.fill();

    if (!kept) {
      bctx.fillStyle = 'rgba(0,0,0,0.25)';
      bctx.beginPath();
      bctx.ellipse(c.sx, c.sy + 1, 5, 2.4, 0, 0, Math.PI * 2);
      bctx.fill();
      // the little arrow that helps whoever left it find it again
      const ay = y - 30 - Math.abs(Math.sin(t * 2.4)) * 3;
      bctx.fillStyle = '#f0c368';
      bctx.beginPath();
      bctx.moveTo(c.sx, ay + 6);
      bctx.lineTo(c.sx - 4, ay);
      bctx.lineTo(c.sx + 4, ay);
      bctx.closePath();
      bctx.fill();
    }
  }

  // ---------------------------------------------------------------- marks

  /** A mark he left behind: a small flat stone with something scratched in it. */
  function drawMark(mk) {
    const c = project(mk.x + 0.5, mk.y + 0.5);
    const sx = Math.round(c.sx);
    const sy = Math.round(c.sy);
    bctx.fillStyle = 'rgba(0,0,0,0.22)';
    bctx.beginPath();
    bctx.ellipse(sx, sy + 1, 6, 2.4, 0, 0, Math.PI * 2);
    bctx.fill();
    bctx.fillStyle = '#cfc4ad';
    bctx.fillRect(sx - 5, sy - 8, 10, 8);
    bctx.fillStyle = '#b3a894';
    bctx.fillRect(sx - 5, sy - 8, 10, 1);
    bctx.fillStyle = 'rgba(72,62,50,0.75)';
    bctx.fillRect(sx - 3, sy - 5, 6, 1);
    bctx.fillRect(sx - 3, sy - 3, 4, 1);
  }

  /** Something he made: a small thing standing in the street, of whatever kind it is. */
  function drawCreation(ms, dark = 0) {
    const c = project(ms.x + 0.5, ms.y + 0.5);
    const sx = Math.round(c.sx);
    const sy = Math.round(c.sy);
    const cond = typeof ms.condition === 'number' ? ms.condition : 1;
    const kind = ms.kind || 'ornament';
    const stage = ms.stage || 0;
    bctx.fillStyle = 'rgba(0,0,0,0.22)';
    bctx.beginPath();
    bctx.ellipse(sx, sy + 1, 6, 2.4, 0, 0, Math.PI * 2);
    bctx.fill();

    // it has come apart where it stood and is not a place any more
    if (cond <= 0) {
      bctx.fillStyle = '#5c4c3a';
      bctx.fillRect(sx - 5, sy - 3, 4, 2);
      bctx.fillRect(sx + 1, sy - 2, 4, 2);
      bctx.fillStyle = '#3d3529';
      bctx.fillRect(sx - 2, sy - 5, 3, 2);
      bctx.fillStyle = 'rgba(230,217,191,0.45)';
      bctx.fillRect(sx + 2, sy - 6, 3, 1);
      return;
    }

    if (kind === 'light') {
      if (dark > 0.15) {
        const g = bctx.createRadialGradient(sx, sy - 4, 1, sx, sy - 4, 16);
        g.addColorStop(0, `rgba(255,214,150,${(0.34 * dark).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,214,150,0)');
        bctx.fillStyle = g;
        bctx.beginPath();
        bctx.ellipse(sx, sy - 2, 16, 9, 0, 0, Math.PI * 2);
        bctx.fill();
      }
      bctx.fillStyle = '#3a3d44';
      bctx.fillRect(sx - 1, sy - 10, 2, 10);
      bctx.fillStyle = '#ffd696';
      bctx.fillRect(sx - 3, sy - 14, 6, 4);
      bctx.fillStyle = 'rgba(255,255,255,0.7)';
      bctx.fillRect(sx - 2, sy - 13, 2, 1);
    } else if (kind === 'seat') {
      bctx.fillStyle = '#6b5b46';
      bctx.fillRect(sx - 6, sy - 5, 12, 2);
      bctx.fillRect(sx - 5, sy - 3, 1, 3);
      bctx.fillRect(sx + 4, sy - 3, 1, 3);
      bctx.fillStyle = '#8a7357';
      bctx.fillRect(sx - 6, sy - 7, 12, 1);
    } else if (kind === 'shelter') {
      bctx.fillStyle = '#5b5142';
      bctx.fillRect(sx - 7, sy - 4, 14, 4);
      bctx.fillStyle = '#3d3529';
      bctx.fillRect(sx - 5, sy - 8, 10, 4);
      bctx.fillStyle = 'rgba(20,16,12,0.85)';
      bctx.fillRect(sx - 3, sy - 7, 6, 3);
      bctx.fillStyle = '#7d6e58';
      bctx.beginPath();
      bctx.moveTo(sx - 8, sy - 8);
      bctx.lineTo(sx, sy - 14);
      bctx.lineTo(sx + 8, sy - 8);
      bctx.closePath();
      bctx.fill();
    } else if (kind === 'sign') {
      bctx.fillStyle = '#6b5b46';
      bctx.fillRect(sx - 1, sy - 6, 2, 6);
      bctx.fillStyle = '#e6d9bf';
      bctx.fillRect(sx - 6, sy - 12, 12, 6);
      bctx.fillStyle = 'rgba(74,63,48,0.8)';
      bctx.fillRect(sx - 4, sy - 10, 8, 1);
      bctx.fillRect(sx - 4, sy - 8, 5, 1);
    } else if (kind === 'garden') {
      bctx.fillStyle = '#3f3a2a';
      bctx.fillRect(sx - 7, sy - 2, 14, 3);
      if (stage <= 0) {
        bctx.fillStyle = '#6f8f4a';
        bctx.fillRect(sx - 5, sy - 4, 2, 2);
        bctx.fillRect(sx - 1, sy - 5, 2, 3);
        bctx.fillRect(sx + 3, sy - 4, 2, 2);
      } else {
        bctx.fillStyle = stage >= 2 ? '#5f8a3f' : '#6f8f4a';
        bctx.fillRect(sx - 6, sy - 8, 12, 6);
        bctx.fillStyle = '#7fae55';
        bctx.fillRect(sx - 4, sy - 11, 8, 4);
        if (stage >= 2) {
          bctx.fillStyle = '#d4553f';
          bctx.fillRect(sx - 5, sy - 7, 2, 2);
          bctx.fillRect(sx + 1, sy - 10, 2, 2);
          bctx.fillRect(sx + 3, sy - 5, 2, 2);
        }
      }
    } else {
      bctx.fillStyle = '#6b5b46';
      bctx.fillRect(sx - 3, sy - 5, 1, 5);
      bctx.fillRect(sx + 2, sy - 5, 1, 5);
      bctx.fillStyle = '#e6d9bf';
      bctx.fillRect(sx - 5, sy - 11, 10, 6);
      bctx.fillStyle = '#c2ae8c';
      bctx.fillRect(sx - 5, sy - 11, 10, 1);
      bctx.fillStyle = 'rgba(74,63,48,0.8)';
      bctx.fillRect(sx - 3, sy - 9, 6, 1);
      bctx.fillRect(sx - 3, sy - 7, 4, 1);
    }
  }

  /** What he calls the thing, over the top of the map. */
  function drawCreationTags(list) {
    const recent = list.slice(-8);
    if (!recent.length) return;
    bctx.save();
    bctx.font = '5px ui-sans-serif, -apple-system, sans-serif';
    bctx.textAlign = 'left';
    bctx.textBaseline = 'middle';
    for (const ms of recent) {
      const c = project(ms.x + 0.5, ms.y + 0.5);
      if (c.sx < -60 || c.sx > baseW + 60 || c.sy < -40 || c.sy > baseH + 40) continue;
      const worn = typeof ms.condition === 'number' ? ms.condition : 1;
      const note = worn <= 0 ? ' \u00b7 fallen' : worn < 0.35 ? ' \u00b7 worn' : '';
      const label = `${String(ms.name || 'something').slice(0, 16)}${note}`;
      const w = Math.ceil(bctx.measureText(label).width) + 8;
      const x = Math.round(c.sx - w / 2);
      const y = Math.round(c.sy) - 20;
      bctx.fillStyle = 'rgba(10,8,7,0.72)';
      bctx.fillRect(x, y, w, 9);
      bctx.fillStyle = 'rgba(230,217,191,0.55)';
      bctx.fillRect(x, y, 1, 9);
      bctx.fillStyle = '#e6d9bf';
      bctx.fillText(label, x + 4, y + 5);
    }
    bctx.restore();
  }

  /** Name tags for crystals nobody has collected yet, so whoever left one can
      find it again. Drawn over the weather and the vignette so they always read. */
  function drawCrystalTags(list, t) {
    const pending = list
      .filter((o) => o.state === 'waiting' || o.state === 'noticed' || o.state === 'found')
      .slice(-10);
    if (!pending.length) return;
    bctx.save();
    bctx.font = '5px ui-sans-serif, -apple-system, sans-serif';
    bctx.textAlign = 'left';
    bctx.textBaseline = 'middle';
    for (const off of pending) {
      const c = project(off.x + 0.5, off.y + 0.5);
      if (c.sx < -60 || c.sx > baseW + 60 || c.sy < -40 || c.sy > baseH + 40) continue;
      const bob = Math.sin(t * 1.8 + off.x * 0.9) * 1.6;
      const who = String(off.from || 'someone').toUpperCase().slice(0, 14);
      const what = off.state === 'found' ? 'LOOKING' : off.state === 'noticed' ? 'SEEN' : 'WAITING';
      const label = `${who} \u00b7 ${what}`;
      const w = Math.ceil(bctx.measureText(label).width) + 8;
      const x = Math.round(c.sx - w / 2);
      const y = Math.round(c.sy - 2 + bob) - 46;
      bctx.fillStyle = 'rgba(10,8,7,0.8)';
      bctx.fillRect(x, y, w, 10);
      bctx.fillStyle = 'rgba(226,180,92,0.6)';
      bctx.fillRect(x, y, 1, 10);
      bctx.fillStyle = '#efe6d8';
      bctx.fillText(label, x + 4, y + 5.5);
    }
    bctx.restore();
  }

  /** What he scratched into the stone, over the top of the map. */
  function drawMarkTags(list) {
    const recent = list.slice(-8);
    if (!recent.length) return;
    bctx.save();
    bctx.font = '5px ui-sans-serif, -apple-system, sans-serif';
    bctx.textAlign = 'left';
    bctx.textBaseline = 'middle';
    for (const mk of recent) {
      const c = project(mk.x + 0.5, mk.y + 0.5);
      if (c.sx < -60 || c.sx > baseW + 60 || c.sy < -40 || c.sy > baseH + 40) continue;
      const label = '"' + String(mk.text || '').replace(/"/g, '').slice(0, 20) + '"';
      const w = Math.ceil(bctx.measureText(label).width) + 8;
      const x = Math.round(c.sx - w / 2);
      const y = Math.round(c.sy) - 26;
      bctx.fillStyle = 'rgba(10,8,7,0.72)';
      bctx.fillRect(x, y, w, 9);
      bctx.fillStyle = 'rgba(207,196,173,0.55)';
      bctx.fillRect(x, y, 1, 9);
      bctx.fillStyle = '#cfc4ad';
      bctx.fillText(label, x + 4, y + 5);
    }
    bctx.restore();
  }

  // ---------------------------------------------------------------- the creature

  function drawCat() {
    const p = project(shown.x, shown.y);
    const sx = Math.round(p.sx);
    const sy = Math.round(p.sy);
    const walking = snap && snap.creature.moving;
    const asleep = snap && snap.creature.asleep;
    const t = performance.now() / 1000;
    const facing = snap ? snap.creature.facing : 's';
    const bob = asleep ? 1 + Math.sin(t * 1.2) * 0.4 : walking ? Math.sin(t * 9) * 1.0 : Math.sin(t * 1.6) * 0.4;

    bctx.fillStyle = 'rgba(0,0,0,0.3)';
    bctx.beginPath();
    bctx.ellipse(sx, sy, asleep ? 11 : 8, asleep ? 4.5 : 3.4, 0, 0, Math.PI * 2);
    bctx.fill();

    const cx = sx;

    if (asleep) {
      // curled up, tail wrapped around the nose
      bctx.fillStyle = '#d8c6a6';
      bctx.beginPath();
      bctx.ellipse(cx, sy - 6 + bob, 11, 7.4, 0, 0, Math.PI * 2);
      bctx.fill();
      bctx.fillStyle = '#3a2a24';
      bctx.beginPath();
      bctx.ellipse(cx + 3, sy - 9 + bob, 5.2, 4.6, 0, 0, Math.PI * 2);
      bctx.fill();
      bctx.fillStyle = '#3a2a24';
      for (const side of [-1, 1]) {
        bctx.beginPath();
        bctx.moveTo(cx + 3 + side * 3, sy - 12 + bob);
        bctx.lineTo(cx + 3 + side * 4.6, sy - 17 + bob);
        bctx.lineTo(cx + 3 + side * 1, sy - 14 + bob);
        bctx.closePath();
        bctx.fill();
      }
      bctx.strokeStyle = '#7fd9f2';
      bctx.lineWidth = 1;
      bctx.beginPath();
      bctx.moveTo(cx + 1, sy - 10 + bob);
      bctx.lineTo(cx + 3, sy - 10 + bob);
      bctx.moveTo(cx + 5, sy - 10 + bob);
      bctx.lineTo(cx + 7, sy - 10 + bob);
      bctx.stroke();
      bctx.strokeStyle = '#3a2a24';
      bctx.lineWidth = 3;
      bctx.beginPath();
      bctx.moveTo(cx - 8, sy - 5 + bob);
      bctx.quadraticCurveTo(cx + 2, sy + 2, cx + 8, sy - 5 + bob);
      bctx.stroke();
      bctx.fillStyle = 'rgba(238,226,208,0.5)';
      bctx.font = '6px ui-sans-serif, sans-serif';
      for (let i = 0; i < 3; i++) {
        const zt = (t * 0.5 + i * 0.33) % 1;
        bctx.fillText('z', cx + 10 + zt * 6, sy - 16 - zt * 12);
      }
      return;
    }

    const bodyTop = sy - 21 + bob;
    const bodyW = 15;
    const bodyH = 18;
    const tailSide = facing === 'w' ? -1 : 1;

    // tail, behind the body and swishing
    bctx.strokeStyle = '#3a2a24';
    bctx.lineWidth = 3.8;
    bctx.lineCap = 'round';
    bctx.beginPath();
    const swish = Math.sin(t * 2.2) * 2.5;
    bctx.moveTo(cx - tailSide * 2, sy - 8 + bob);
    bctx.quadraticCurveTo(cx - tailSide * 10, sy - 11 + bob, cx - tailSide * 9, sy - 18 + bob + swish);
    bctx.stroke();

    // legs
    bctx.fillStyle = '#3a2a24';
    const swing = walking ? Math.sin(t * 9) * 1.8 : 0;
    bctx.fillRect(cx - 5 + swing, sy - 5, 2.8, 5);
    bctx.fillRect(cx + 2.2 - swing, sy - 5, 2.8, 5);

    // body and pale chest
    bctx.fillStyle = '#d8c6a6';
    roundRect(bctx, cx - bodyW / 2, bodyTop, bodyW, bodyH, 6);
    bctx.fill();
    const lookX = facing === 'e' ? 1.1 : facing === 'w' ? -1.1 : 0;
    bctx.fillStyle = '#f0e6d2';
    bctx.beginPath();
    bctx.ellipse(cx + lookX * 0.6, bodyTop + 9, 3.2, 4.8, 0, 0, Math.PI * 2);
    bctx.fill();

    // collar and bell
    bctx.fillStyle = '#ff2d7a';
    bctx.fillRect(cx - 4.6, bodyTop + 2.2, 9.2, 1.7);
    bctx.fillStyle = '#5ffbf1';
    bctx.beginPath();
    bctx.arc(cx, bodyTop + 4.4, 1.2, 0, Math.PI * 2);
    bctx.fill();

    // head
    const hy = bodyTop - 3.5;
    const hx = cx + lookX;    bctx.fillStyle = '#3a2a24';

    bctx.beginPath();
    bctx.arc(hx, hy, 7, 0, Math.PI * 2);
    bctx.fill();

    // ears
    bctx.beginPath();
    bctx.moveTo(hx - 5.2, hy - 4.2);
    bctx.lineTo(hx - 6.4, hy - 9.2);
    bctx.lineTo(hx - 1.8, hy - 5.7);
    bctx.closePath();
    bctx.fill();
    bctx.beginPath();
    bctx.moveTo(hx + 5.2, hy - 4.2);
    bctx.lineTo(hx + 6.4, hy - 9.2);
    bctx.lineTo(hx + 1.8, hy - 5.7);
    bctx.closePath();
    bctx.fill();

    if (facing === 'n') {
      bctx.fillStyle = '#3a2a24';
      bctx.beginPath();
      bctx.arc(hx, hy + 0.8, 4.9, 0, Math.PI * 2);
      bctx.fill();
    } else {
      bctx.fillStyle = '#5a4038';
      for (const side of [-1, 1]) {
        bctx.beginPath();
        bctx.moveTo(hx + side * 4.2, hy - 5.1);
        bctx.lineTo(hx + side * 5.4, hy - 8.2);
        bctx.lineTo(hx + side * 2.2, hy - 6.1);
        bctx.closePath();
        bctx.fill();
      }

      // ice-blue Siamese eyes with a slit pupil
      const blink = Math.sin(t * 0.9 + 1) > 0.985 ? 0.4 : 1;
      for (const side of [-1, 1]) {
        bctx.fillStyle = '#7fd9f2';
        bctx.beginPath();
        bctx.arc(hx + side * 2.35, hy + 0.4, 1.9, 0, Math.PI * 2);
        bctx.fill();
        bctx.fillStyle = '#11120f';
        bctx.fillRect(Math.round(hx + side * 2.35), Math.round(hy - 1.1 * blink), 0.8, Math.max(1, 2.2 * blink));
      }

      // muzzle, nose, whiskers
      bctx.fillStyle = '#f0e6d2';
      bctx.beginPath();
      bctx.ellipse(hx + lookX * 0.4, hy + 3.5, 2.9, 1.9, 0, 0, Math.PI * 2);
      bctx.fill();
      bctx.fillStyle = '#5a4038';
      bctx.beginPath();
      bctx.moveTo(hx + lookX * 0.4, hy + 2.3);
      bctx.lineTo(hx + lookX * 0.4 - 0.8, hy + 3.3);
      bctx.lineTo(hx + lookX * 0.4 + 0.8, hy + 3.3);
      bctx.closePath();
      bctx.fill();
      bctx.strokeStyle = 'rgba(220,210,190,.55)';
      bctx.lineWidth = 0.5;
      for (const side of [-1, 1]) {
        for (let k = 0; k < 2; k++) {
          bctx.beginPath();
          bctx.moveTo(hx + lookX * 0.4 + side * 3, hy + 3 + k * 0.8);
          bctx.lineTo(hx + lookX * 0.4 + side * 7, hy + 2 + k * 1.6);
          bctx.stroke();
        }
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------------- weather & light

  function applyNight(dark) {
    if (dark <= 0.01) return;
    bctx.save();
    bctx.globalCompositeOperation = 'multiply';
    const g = bctx.createLinearGradient(0, 0, 0, baseH);
    g.addColorStop(0, `rgba(38,48,86,${0.35 + dark * 0.5})`);
    g.addColorStop(1, `rgba(24,26,52,${0.42 + dark * 0.5})`);
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, baseW, baseH);
    bctx.restore();
  }

  function drawLights(dark) {
    if (dark <= 0.05) return;
    bctx.save();
    bctx.globalCompositeOperation = 'lighter';
    for (const l of lampLights) {
      const a = (0.16 + (l.flicker || 0)) * dark;
      const g = bctx.createRadialGradient(l.x, l.y, 1, l.x, l.y, l.r);
      g.addColorStop(0, `rgba(255,214,140,${a})`);
      g.addColorStop(1, 'rgba(255,190,110,0)');
      bctx.fillStyle = g;
      bctx.beginPath();
      bctx.arc(l.x, l.y, l.r, 0, Math.PI * 2);
      bctx.fill();
    }
    for (const w of litWindows) {
      const a = 0.1 * dark * (w.warm || 0.6);
      const g = bctx.createRadialGradient(w.x, w.y, 1, w.x, w.y, w.r);
      g.addColorStop(0, `rgba(255,205,130,${a})`);
      g.addColorStop(1, 'rgba(255,190,110,0)');
      bctx.fillStyle = g;
      bctx.beginPath();
      bctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
      bctx.fill();
    }
    bctx.restore();
  }

  function drawWeather(kind, t) {
    if (kind === 'rain') {
      bctx.strokeStyle = 'rgba(190,215,235,0.3)';
      bctx.lineWidth = 0.7;
      bctx.beginPath();
      for (let i = 0; i < 70; i++) {
        const seed = hash(i, 7);
        const speed = 120 + seed * 90;
        const x = ((seed * baseW + t * 30) % (baseW + 60)) - 30;
        const y = ((hash(i, 11) * baseH + t * speed) % (baseH + 40)) - 20;
        bctx.moveTo(x, y);
        bctx.lineTo(x - 2, y + 7);
      }
      bctx.stroke();
    } else if (kind === 'fog') {
      for (let i = 0; i < 3; i++) {
        const yy = ((t * 6 + i * baseH * 0.34) % (baseH + 80)) - 40;
        const g = bctx.createLinearGradient(0, yy - 30, 0, yy + 30);
        g.addColorStop(0, 'rgba(210,220,225,0)');
        g.addColorStop(0.5, 'rgba(210,220,225,0.1)');
        g.addColorStop(1, 'rgba(210,220,225,0)');
        bctx.fillStyle = g;
        bctx.fillRect(0, yy - 30, baseW, 60);
      }
    } else if (kind === 'wind') {
      bctx.strokeStyle = 'rgba(230,225,210,0.14)';
      bctx.lineWidth = 0.8;
      bctx.beginPath();
      for (let i = 0; i < 18; i++) {
        const seed = hash(i, 3);
        const y = seed * baseH;
        const x = ((t * (90 + seed * 60) + i * 140) % (baseW + 200)) - 100;
        bctx.moveTo(x, y);
        bctx.lineTo(x + 26 + seed * 20, y - 1);
      }
      bctx.stroke();
    }
  }

  function drawVignette() {
    const g = bctx.createRadialGradient(baseW / 2, baseH / 2, Math.min(baseW, baseH) * 0.28, baseW / 2, baseH / 2, Math.max(baseW, baseH) * 0.78);
    g.addColorStop(0, 'rgba(16,12,10,0)');
    g.addColorStop(1, 'rgba(16,12,10,0.5)');
    bctx.fillStyle = g;
    bctx.fillRect(0, 0, baseW, baseH);
  }

  // ---------------------------------------------------------------- frame

  let lastFrame = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    const t = now / 1000;

    if (!town) {
      renderEmpty();
      return;
    }

    // smooth the creature and the camera toward the server's truth
    if (snap) {
      const k = 1 - Math.pow(0.001, dt);
      shown.x += (snap.creature.x - shown.x) * k;
      shown.y += (snap.creature.y - shown.y) * k;
      shown.dir = snap.creature.facing;
    }
    const camTargetX = shown.x + drag.ox;
    const camTargetY = shown.y + drag.oy;
    const ck = 1 - Math.pow(0.008, dt);
    cam.x += (camTargetX - cam.x) * ck;
    cam.y += (camTargetY - cam.y) * ck;

    const dark = snap ? snap.darkness : 0;
    const nightish = dark > 0.35;

    bctx.fillStyle = nightish ? '#0d1017' : '#151a16';
    bctx.fillRect(0, 0, baseW, baseH);

    litWindows.length = 0;
    lampLights.length = 0;

    drawGround(t);

    const drawables = [];

    for (const pr of town.props) {
      let fn = null;
      switch (pr.kind) {
        case 'tree':
          fn = () => drawTree(pr, t);
          break;
        case 'lamp':
          fn = () => drawLamp(pr, t);
          break;
        case 'bench':
          fn = () => drawBench(pr);
          break;
        case 'fountain':
          fn = () => drawFountain(pr, t);
          break;
        case 'payphone':
          fn = () => drawPayphone(pr);
          break;
        case 'crate':
          fn = () => drawCrate(pr);
          break;
        case 'grave':
          fn = () => drawGrave(pr);
          break;
        case 'flower':
          fn = () => drawFlower(pr, t);
          break;
      }
      if (fn) drawables.push({ d: pr.x + pr.y + 0.5, fn });
    }

    for (const p of town.places) {
      if (p.kind === 'area') continue;
      drawables.push({ d: p.rect.x + p.rect.w - 0.9 + p.rect.y + p.rect.h - 0.9, fn: () => drawBuilding(p, t) });
    }

    for (const off of snap ? snap.offerings : []) {
      drawables.push({ d: off.x + off.y + 0.55, fn: () => drawCrystal(off, t) });
    }

    for (const mk of snap ? snap.marks || [] : []) {
      drawables.push({ d: mk.x + mk.y + 0.5, fn: () => drawMark(mk) });
    }

    for (const made of snap ? snap.creations || [] : []) {
      drawables.push({ d: made.x + made.y + 0.5, fn: () => drawCreation(made, dark) });
    }

    drawables.push({
      d: Math.floor(shown.x) + Math.floor(shown.y) + 0.75,
      fn: drawCat,
    });

    drawables.sort((a, b) => a.d - b.d);
    for (const d of drawables) d.fn();

    // kept crystals in the ruins stay for good
    drawLights(dark);
    applyNight(dark);
    drawWeather(snap ? snap.weather : 'clear', t);
    drawVignette();

    if (snap) {
      drawCrystalTags(snap.offerings || [], t);
      drawMarkTags(snap.marks || []);
      drawCreationTags(snap.creations || []);
    }

    view.imageSmoothingEnabled = false;
    view.clearRect(0, 0, canvas.width, canvas.height);
    view.drawImage(base, 0, 0, baseW * scale * dpr, baseH * scale * dpr);
  }

  function renderEmpty() {
    bctx.fillStyle = '#12100e';
    bctx.fillRect(0, 0, baseW, baseH);
    view.drawImage(base, 0, 0, baseW * scale * dpr, baseH * scale * dpr);
  }

  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- input

  canvas.addEventListener('pointerdown', (e) => {
    drag.active = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    canvas.classList.add('drag');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag.active) return;
    const dx = (e.clientX - drag.x) / (TW / 2) / scale / 2;
    const dy = (e.clientY - drag.y) / (TH / 2) / scale / 2;
    drag.ox -= dx;
    drag.oy -= dy;
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const endDrag = () => {
    drag.active = false;
    canvas.classList.remove('drag');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', endDrag);
  canvas.addEventListener('dblclick', () => {
    drag.ox = 0;
    drag.oy = 0;
  });

  function setScale(next) {
    scale = Math.max(2, Math.min(6, next));
    resize();
  }
  document.getElementById('z-in').addEventListener('click', () => setScale(scale + 1));
  document.getElementById('z-out').addEventListener('click', () => setScale(scale - 1));
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    setScale(scale + (e.deltaY < 0 ? 1 : -1));
  }, { passive: true });

  // ---------------------------------------------------------------- splash

  const splash = document.getElementById('splash');
  const bar = splash.querySelector('.bar i');
  const msg = splash.querySelector('.msg');
  let progress = 0;
  const ticker = setInterval(() => {
    progress = Math.min(0.85, progress + 0.14);
    bar.style.width = Math.round(progress * 100) + '%';
    if (progress > 0.4) msg.textContent = 'finding him';
    if (progress > 0.7) msg.textContent = 'he is already awake';
  }, 320);

  function ready() {
    clearInterval(ticker);
    bar.style.width = '100%';
    msg.textContent = '';
    setTimeout(() => splash.classList.add('gone'), 420);
  }
  if (snap) ready();
  else {
    const wait = setInterval(() => {
      if (snap) {
        clearInterval(wait);
        ready();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(wait);
      if (!snap) {
        msg.textContent = 'the town is not answering';
        ready();
      }
    }, 9000);
  }

  setInterval(() => {
    if (snap && Date.now() - stateAt > 20000) {
      document.getElementById('doing-label').textContent = 'the town has gone quiet';
    }
  }, 5000);
})();
