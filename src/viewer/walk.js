/* Fenwick, first person. You walk in at the fountain with no avatar between you
   and the town. WASD, shift to run, mouse to look. Mochi is out there living his
   own day, tracked live over SSE. The scene is rendered small and forced through
   an ordered-dither palette, which is both the art direction and a way of hiding
   the seams in a town built out of boxes. Nothing here changes him. */

import * as THREE from '/vendor/three.module.min.js';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('scene');

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const damp = (a, b, k) => a + (b - a) * k;
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const dampAngle = (a, b, k) => a + wrapPi(b - a) * k;
  const hash2 = (x, y) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };

  /* tile codes, mirrored from src/world/map.ts */
  const T = { grass: 0, road: 1, water: 2, plaza: 3, building: 4, tree: 5, rubble: 6, sand: 7, dirt: 8 };
  const TILE_COLOUR = [
    '#4d6039', // grass
    '#6d695c', // road
    '#244a50', // water (under the surface)
    '#8b8577', // plaza
    '#5d574c', // building footprint
    '#39482f', // tree / grass under it
    '#736d61', // rubble
    '#b7a57f', // sand
    '#6b5942', // dirt
  ];
  const FACING_YAW = { e: Math.PI / 2, s: 0, w: -Math.PI / 2, n: Math.PI };
  const SKY_DAY = {
    clear: { top: '#557694', bottom: '#c7cbb1' },
    overcast: { top: '#6c736f', bottom: '#b4b3a2' },
    rain: { top: '#434e54', bottom: '#7f877f' },
    fog: { top: '#899187', bottom: '#bfc1ad' },
    wind: { top: '#587881', bottom: '#c1c9b4' },
  };
  const FOG_BY_WEATHER = { clear: 0.008, overcast: 0.014, rain: 0.022, fog: 0.045, wind: 0.011 };
  const LIGHT_BY_WEATHER = { clear: 1, overcast: 0.64, rain: 0.4, fog: 0.34, wind: 0.92 };

  // Each building gets its own small, deliberately limited palette so the town
  // reads as one place rather than eight unrelated boxes.
  const STYLE = {
    nest: { wall: '#d3bd97', roof: '#714334', trim: '#382820', timber: '#493327', accent: '#a56a3c', height: 2.55 },
    bakery: { wall: '#dcc59f', roof: '#7d4a37', trim: '#432b21', timber: '#50372a', accent: '#b26a42', height: 2.6 },
    laundrette: { wall: '#bcc7c0', roof: '#3d565b', trim: '#25363a', timber: '#33494c', accent: '#6f9298', height: 2.45 },
    bar: { wall: '#987c73', roof: '#3b2b32', trim: '#231a1e', timber: '#3a2a2e', accent: '#8d4b3d', height: 3.15 },
    library: { wall: '#c5bfa6', roof: '#3d4b39', trim: '#242f23', timber: '#34402f', accent: '#6d7b58', height: 3.15 },
    market: { wall: '#d1b98c', roof: '#81632f', trim: '#46351b', timber: '#554123', accent: '#a8853f', height: 2.55 },
    salon: { wall: '#d2b7ba', roof: '#64404d', trim: '#38232a', timber: '#4b3138', accent: '#9b6071', height: 2.55 },
    tower: { wall: '#a8afa9', roof: '#303a40', trim: '#20272b', timber: '#384349', accent: '#75827f', height: 6.8 },
  };

  // ---------------------------------------------------------------- renderer

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (err) {
    const fail = $('fail');
    fail.style.display = 'flex';
    fail.textContent = `This browser could not start WebGL, so the town cannot be drawn. (${err.message})`;
    $('loading').classList.add('gone');
    return;
  }
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x0b0f10, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9aa29c, 0.012);
  const camera = new THREE.PerspectiveCamera(71, 1, 0.08, 520);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  // ---------------------------------------------------------------- dithered output
  //
  // The scene is drawn at roughly 480-540p into a buffer with no antialiasing.
  // A full-screen pass then maps those linear colours through a fixed 22-colour
  // palette using an 8x8 ordered dither. Everything is intentionally a little
  // too limited: hard edges and palette dots do more for the look than detail.

  const PALETTE_HEX = [
    '#06090a', '#0d1314', '#151d1e', '#1e2827', '#293531', '#36443b',
    '#455446', '#56664f', '#6b7a5b', '#85906b', '#a3a67d', '#c1bd91',
    '#ddd2a4', '#f0e3b8', '#1b2937', '#2a3e4d', '#3f5965', '#607b7d',
    '#8fa39b', '#51372a', '#7b4d34', '#a96842', '#d18b53', '#efb86f',
  ];
  const PALETTE = PALETTE_HEX.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  });
  const PALETTE_N = PALETTE.length;

  const lowTarget = new THREE.WebGLRenderTarget(2, 2, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  lowTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postUniforms = {
    tDiffuse: { value: lowTarget.texture },
    uPalette: { value: PALETTE },
    uLowRes: { value: new THREE.Vector2(2, 2) },
    uDither: { value: 2.0 },
    uTime: { value: 0 },
  };
  const postMaterial = new THREE.ShaderMaterial({
    uniforms: postUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform vec3 uPalette[${PALETTE_N}];
      uniform vec2 uLowRes;
      uniform float uDither;
      uniform float uTime;
      varying vec2 vUv;

      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

      // recursive 2x2 -> 8x8 ordered dither, in [0,1]
      float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
      float bayer4(vec2 a) { return bayer2(a * 0.5) * 0.25 + bayer2(a); }
      float bayer8(vec2 a) { return bayer4(a * 0.5) * 0.25 + bayer2(a); }

      void main() {
        vec2 texel = 1.0 / uLowRes;
        vec3 raw = texture2D(tDiffuse, vUv).rgb;
        float l = luma(raw);
        float lx = luma(texture2D(tDiffuse, vUv + vec2(texel.x, 0.0)).rgb);
        float ly = luma(texture2D(tDiffuse, vUv + vec2(0.0, texel.y)).rgb);

        vec3 col = pow(max(raw, vec3(0.0)), vec3(1.0 / 2.2));
        col = mix(vec3(luma(col)), col, 0.93);
        col = (col - 0.5) * 1.13 + 0.5 + 0.008;

        // Grade before quantization, never after: anything applied to a palette
        // colour would multiply it into shades and undo the limited palette.
        float edge = smoothstep(0.055, 0.3, abs(l - lx) + abs(l - ly));
        col *= 1.0 - edge * 0.3;
        float vig = 1.0 - 0.32 * smoothstep(0.26, 0.78, length(vUv - 0.5));
        col *= vig;
        float grain = fract(sin(dot(gl_FragCoord.xy + uTime * 0.7, vec2(12.9898, 78.233))) * 43758.5453);
        col += (grain - 0.5) * 0.02;
        col = clamp(col, 0.0, 1.0);

        vec3 c1 = uPalette[0];
        vec3 c2 = uPalette[0];
        float d1 = 99.0;
        float d2 = 99.0;
        for (int i = 0; i < ${PALETTE_N}; i++) {
          vec3 c = uPalette[i];
          float d = distance(col, c);
          if (d < d1) {
            d2 = d1; c2 = c1;
            d1 = d; c1 = c;
          } else if (d < d2) {
            d2 = d; c2 = c;
          }
        }

        float mixT = d1 / (d1 + d2 + 0.0001);
        float threshold = bayer8(floor(gl_FragCoord.xy / uDither));
        vec3 outCol = mix(c1, c2, step(threshold, mixT));

        gl_FragColor = vec4(outCol, 1.0);
      }`,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial));

  let lowW = 2;
  let lowH = 2;
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const scale = Math.min(1, 540 / h, 900 / w);
    lowW = Math.max(200, Math.round(w * scale));
    lowH = Math.max(120, Math.round(h * scale));
    lowTarget.setSize(lowW, lowH);
    postUniforms.uLowRes.value.set(lowW, lowH);
    postUniforms.uDither.value = clamp(h / 430, 1.4, 3.0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- sky

  const skyUniforms = {
    top: { value: new THREE.Color('#557694') },
    bottom: { value: new THREE.Color('#c7cbb1') },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(280, 32, 18),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: skyUniforms,
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 top;
        uniform vec3 bottom;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld).y;
          float t = pow(clamp(h, 0.0, 1.0), 0.5);
          float band = sin(h * 18.0) * 0.012 + sin(h * 43.0) * 0.006;
          gl_FragColor = vec4(mix(bottom, top, t) + band, 1.0);
        }`,
    }),
  );
  sky.frustumCulled = false;
  scene.add(sky);

  {
    const count = 700;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const y = Math.random() * 0.9 + 0.06;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * r * 250;
      pos[i * 3 + 1] = y * 250;
      pos[i * 3 + 2] = Math.sin(a) * r * 250;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0xdbe6ff,
        size: 1.1,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
        sizeAttenuation: true,
      }),
    );
    stars.frustumCulled = false;
    scene.add(stars);
  }

  // ---------------------------------------------------------------- lights

  const hemi = new THREE.HemisphereLight(0xb8cbd2, 0x383828, 0.9);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x46525a, 0.28);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff0d2, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -28;
  sun.shadow.camera.right = 28;
  sun.shadow.camera.top = 28;
  sun.shadow.camera.bottom = -28;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 170;
  sun.shadow.bias = -0.0007;
  sun.shadow.normalBias = 0.025;
  sun.target.position.set(18, 0, 18);
  scene.add(sun, sun.target);

  const celestial = new THREE.Group();
  const sunDisc = new THREE.Mesh(
    new THREE.SphereGeometry(5.2, 16, 10),
    new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 1, fog: false }),
  );
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xe4edfa, transparent: true, opacity: 0, fog: false });
  const moonDisc = new THREE.Mesh(new THREE.SphereGeometry(3.8, 16, 10), moonMat);
  celestial.add(sunDisc, moonDisc);
  scene.add(celestial);

  function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, inner);
    grd.addColorStop(0.45, inner.replace(/[\d.]+\)$/, '0.35)'));
    grd.addColorStop(1, outer);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const glowTex = radialTexture('rgba(255,232,190,1)', 'rgba(255,210,140,0)');
  const smokeTex = radialTexture('rgba(210,210,196,1)', 'rgba(190,190,180,0)');

  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: 0xffd9a0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  sunGlow.scale.setScalar(48);
  sunDisc.add(sunGlow);
  const moonGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: 0xcfe0ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  moonGlow.scale.setScalar(38);
  moonDisc.add(moonGlow);

  // ---------------------------------------------------------------- first person

  const player = {
    x: 17.5,
    z: 20.5,
    yaw: 0.02,
    pitch: -0.02,
    vx: 0,
    vz: 0,
    phase: 0,
    roll: 0,
    eye: 1.58,
    moving: 0,
  };
  const keys = Object.create(null);

  // A small hand-lantern sits at the edge of the frame. It gives the first-person
  // view a body without putting an avatar in the world.
  function makeFirstPersonLantern() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x201d18, roughness: 0.65, metalness: 0.45 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0xffd9a0,
      emissive: 0xff9e48,
      emissiveIntensity: 1.25,
      roughness: 0.25,
      transparent: true,
      opacity: 0.86,
    });
    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.5, 3, 7), new THREE.MeshStandardMaterial({ color: 0x2b3b40, roughness: 1 }));
    sleeve.position.set(0.23, -0.23, 0.18);
    sleeve.rotation.x = -1.05;
    sleeve.rotation.z = -0.42;
    g.add(sleeve);

    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.014, 5, 10, Math.PI), metal);
    handle.position.set(0.06, -0.16, 0);
    g.add(handle);
    const cage = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.14), metal);
    cage.position.set(0.06, -0.27, 0);
    g.add(cage);
    const pane = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.13, 0.105), glass);
    pane.position.set(0.06, -0.27, 0);
    g.add(pane);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.07, 4), metal);
    cap.position.set(0.06, -0.155, 0);
    cap.rotation.y = Math.PI / 4;
    g.add(cap);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0xffbd72, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.scale.setScalar(0.9);
    glow.position.set(0.06, -0.27, 0);
    g.add(glow);

    const light = new THREE.PointLight(0xffb168, 0.5, 7, 2);
    light.position.set(0.06, -0.24, 0.02);
    g.add(light);

    g.position.set(0.31, -0.31, -0.58);
    g.rotation.z = -0.06;
    g.userData = { light, glow: glow.material, pane };
    return g;
  }
  const handLantern = makeFirstPersonLantern();
  camera.add(handLantern);

  // ---------------------------------------------------------------- mochi

  function makeLabel(text) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '600 58px Georgia, "Times New Roman", serif';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillText(text, 257, 67);
    g.fillStyle = '#fff0d4';
    g.fillText(text, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function makeCat() {
    const g = new THREE.Group();
    const fur = new THREE.MeshStandardMaterial({ color: 0x2a2926, roughness: 0.96 });
    const furLight = new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.96 });
    const chest = new THREE.MeshStandardMaterial({ color: 0xc9bca6, roughness: 0.9 });
    const pink = new THREE.MeshStandardMaterial({ color: 0xa86f66, roughness: 0.85 });
    const amber = new THREE.MeshStandardMaterial({ color: 0xd8a24b, emissive: 0x6a4310, emissiveIntensity: 0.55, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0d0c, roughness: 0.45 });
    const collarMat = new THREE.MeshStandardMaterial({ color: 0x7b2f2f, roughness: 0.75 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb99045, roughness: 0.4, metalness: 0.45 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 12), fur);
    body.scale.set(1.0, 1.12, 1.55);
    body.position.y = 0.29;
    body.castShadow = true;
    g.add(body);

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.185, 14, 10), chest);
    belly.scale.set(0.9, 0.95, 1.25);
    belly.position.set(0, 0.29, 0.075);
    g.add(belly);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), fur);
    head.position.set(0, 0.54, 0.25);
    head.castShadow = true;
    g.add(head);

    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 9), furLight);
    mask.scale.set(1.15, 0.82, 0.72);
    mask.position.set(0, 0.52, 0.355);
    g.add(mask);

    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), chest);
    muzzle.scale.set(1.2, 0.85, 0.9);
    muzzle.position.set(0, 0.49, 0.395);
    g.add(muzzle);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.027, 0.045, 4), pink);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.512, 0.45);
    g.add(nose);

    const ears = [];
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.058, 0.16, 4), fur);
      ear.position.set(side * 0.085, 0.685, 0.235);
      ear.rotation.z = side * -0.24;
      ear.rotation.x = -0.08;
      ear.castShadow = true;
      g.add(ear);
      ears.push(ear);
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.031, 0.095, 4), pink);
      inner.position.set(side * 0.085, 0.688, 0.26);
      inner.rotation.z = side * -0.24;
      inner.rotation.x = -0.08;
      g.add(inner);

      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8), amber);
      eye.position.set(side * 0.064, 0.565, 0.385);
      g.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), dark);
      pupil.scale.set(0.55, 1.2, 0.55);
      pupil.position.set(side * 0.064, 0.565, 0.42);
      g.add(pupil);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      glint.position.set(side * 0.072, 0.576, 0.432);
      g.add(glint);
      g.userData[side < 0 ? 'eyeL' : 'eyeR'] = eye;
    }

    // whiskers
    const whiskerMat = new THREE.MeshBasicMaterial({ color: 0xb9ad97 });
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.2, 3), whiskerMat);
        w.position.set(side * 0.11, 0.485 + i * 0.011, 0.41);
        w.rotation.z = Math.PI / 2;
        w.rotation.y = side * (0.28 + i * 0.12);
        g.add(w);
      }
    }

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.024, 6, 14), collarMat);
    collar.rotation.x = Math.PI / 2;
    collar.position.set(0, 0.425, 0.24);
    g.add(collar);
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.038, 9, 7), brass);
    bell.position.set(0, 0.385, 0.33);
    g.add(bell);

    const legs = [];
    for (const side of [-1, 1]) {
      for (const front of [1, -1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.038, 0.22, 6), fur);
        leg.position.set(side * 0.115, 0.13, front * 0.19);
        leg.castShadow = true;
        g.add(leg);
        legs.push(leg);
        const paw = new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 6), furLight);
        paw.scale.set(1.0, 0.55, 1.2);
        paw.position.set(side * 0.115, 0.026, front * 0.21);
        g.add(paw);
      }
    }

    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.33, -0.3),
      new THREE.Vector3(0.02, 0.44, -0.46),
      new THREE.Vector3(0.08, 0.63, -0.52),
      new THREE.Vector3(0.16, 0.73, -0.44),
      new THREE.Vector3(0.18, 0.75, -0.35),
    ]);
    const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 14, 0.036, 5, false), fur);
    tail.castShadow = true;
    g.add(tail);

    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeLabel('Mochi'), transparent: true, depthWrite: false, depthTest: true }),
    );
    label.scale.set(1.25, 0.3125, 1);
    label.position.set(0, 1.05, 0);
    g.add(label);

    const rim = new THREE.PointLight(0xffbf78, 0, 4.5, 2);
    rim.position.set(0, 0.5, 0.28);
    g.add(rim);

    g.userData = { ...g.userData, legs, ears, tail, body, head, label, light: rim, bell };
    return g;
  }

  const mochiGroup = makeCat();
  const mochi = {
    x: 17.5,
    z: 20.5,
    yaw: 0,
    phase: 0,
    placed: false,
    moving: false,
    asleep: false,
  };
  mochiGroup.position.set(mochi.x, 0, mochi.z);
  scene.add(mochiGroup);

  // ---------------------------------------------------------------- shared materials + textures

  const matCache = new Map();
  function mat(hex, rough = 0.9, metal = 0, flat = false) {
    const key = `${hex}/${rough}/${metal}/${flat}`;
    if (matCache.has(key)) return matCache.get(key);
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal, flatShading: flat });
    matCache.set(key, m);
    return m;
  }
  function box(w, h, d, hex, x, y, z, parent) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(hex));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function canvasTexture(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 2;
    return tex;
  }

  const windowTex = canvasTexture(64, 96, (g, w, h) => {
    g.fillStyle = '#2a2620';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#191d1c';
    g.fillRect(6, 6, w - 12, h - 12);
    const grd = g.createLinearGradient(0, 8, 0, h - 8);
    grd.addColorStop(0, '#74898a');
    grd.addColorStop(0.55, '#394a4a');
    grd.addColorStop(1, '#202a29');
    g.fillStyle = grd;
    g.fillRect(10, 10, w - 20, h - 20);
    g.fillStyle = '#2a2620';
    g.fillRect(w / 2 - 2, 8, 4, h - 16);
    g.fillRect(8, h / 2 - 2, w - 16, 4);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(12, 12, 13, h - 24);
  });
  const windowGlowTex = canvasTexture(64, 96, (g, w, h) => {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    const grd = g.createLinearGradient(0, 12, 0, h - 12);
    grd.addColorStop(0, '#ffd99a');
    grd.addColorStop(1, '#b56532');
    g.fillStyle = grd;
    g.fillRect(10, 10, w - 20, h - 20);
    g.fillStyle = '#000000';
    g.fillRect(w / 2 - 2, 10, 4, h - 20);
    g.fillRect(10, h / 2 - 2, w - 20, 4);
  });
  const windowMat = new THREE.MeshStandardMaterial({
    map: windowTex,
    emissive: 0xffb060,
    emissiveMap: windowGlowTex,
    emissiveIntensity: 0.04,
    roughness: 0.38,
  });

  const doorTex = canvasTexture(64, 128, (g, w, h) => {
    g.fillStyle = '#2e241d';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? '#5a4130' : '#644936';
      g.fillRect(6 + i * 14, 6, 11, h - 12);
    }
    g.fillStyle = '#1c1612';
    g.fillRect(0, 0, 6, h);
    g.fillRect(w - 6, 0, 6, h);
    g.fillStyle = '#c49b52';
    g.beginPath();
    g.arc(w - 16, h * 0.55, 3.5, 0, Math.PI * 2);
    g.fill();
  });
  const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.85 });

  function makeSignTexture(text, accent) {
    return canvasTexture(320, 108, (g, w, h) => {
      g.fillStyle = '#221c17';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = accent;
      g.lineWidth = 5;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = accent;
      g.fillRect(16, 16, 7, h - 32);
      g.fillStyle = '#e7d8b9';
      g.font = '600 37px Georgia, "Times New Roman", serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2 + 6, h / 2 + 2, w - 46);
    });
  }

  function makeAwningTexture(accent) {
    const tex = canvasTexture(64, 64, (g, w, h) => {
      g.fillStyle = '#d9c9a6';
      g.fillRect(0, 0, w, h);
      g.fillStyle = accent;
      for (let i = 0; i < w; i += 16) g.fillRect(i, 0, 8, h);
      g.fillStyle = 'rgba(0,0,0,0.12)';
      g.fillRect(0, h - 9, w, 9);
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(3, 1);
    return tex;
  }

  const signMats = new Map();
  function signMaterial(place) {
    if (signMats.has(place.id)) return signMats.get(place.id);
    const style = STYLE[place.id] ?? STYLE.nest;
    const tex = makeSignTexture(place.id === 'laundrette' ? "SUDSY'S" : place.name.toUpperCase(), style.accent);
    const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    signMats.set(place.id, m);
    return m;
  }

  // ---------------------------------------------------------------- world state

  let town = null;
  let snap = null;
  let townReady = false;
  let started = false;
  const solidProps = [];
  const lampPositions = [];
  const lampGlows = [];
  const lampBulbs = [];
  const crystalMeshes = new Map();
  const lampLights = [];
  const smokePuffs = [];
  const towerBeacon = { group: null, material: null };
  let waterUniforms = null;
  let waterMesh = null;
  let duck = null;
  let rain = null;
  let rainPositions = null;
  let rainCount = 0;
  let chimneyCount = 0;

  function makeLampLightPool() {
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffb765, 0, 9, 2);
      scene.add(l);
      lampLights.push(l);
    }
  }

  function addPropCollider(x, z, r) {
    solidProps.push({ x, z, r });
  }

  // ---------------------------------------------------------------- build: town floor + backdrop

  function buildWorld(t) {
    town = t;
    player.x = t.spawn.x + 0.5;
    player.z = t.spawn.y + 0.5;

    buildFarGround();
    buildGround(t);
    buildBackdrop();
    buildRubble(t);
    buildWater(t);
    buildPondDetails(t);
    buildTrees(t);
    buildFlowers(t);
    buildBushes(t);

    for (const prop of t.props) {
      if (prop.kind === 'lamp') buildLamp(prop);
      else if (prop.kind === 'bench') buildBench(prop);
      else if (prop.kind === 'fountain') buildFountain(prop);
      else if (prop.kind === 'crate') buildCrate(prop);
      else if (prop.kind === 'grave') buildGrave(prop);
      else if (prop.kind === 'payphone') buildPayphone(prop);
    }
    makeLampLightPool();

    for (const prop of t.props) {
      if (!prop.solid || prop.kind === 'tree') continue;
      addPropCollider(prop.x + 0.5, prop.y + 0.5, prop.kind === 'fountain' ? 1.0 : 0.38);
    }

    for (const place of t.places) {
      if (place.kind !== 'area') buildBuilding(place);
    }

    buildRuins(t);
    buildDuck(t);
    buildExtras(t);
    buildSmoke();
    buildRain();

    townReady = true;
    $('sub').textContent = `${t.townName ?? 'the town'}, first person`;
    if (snap) hideLoading();
  }

  function buildFarGround() {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat('#2c3a2b', 1));
    g.rotation.x = -Math.PI / 2;
    g.position.set(18, -0.045, 18);
    g.receiveShadow = true;
    scene.add(g);
  }

  function buildGround(t) {
    const groundGeo = new THREE.PlaneGeometry(1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, metalness: 0 });
    const ground = new THREE.InstancedMesh(groundGeo, groundMat, t.w * t.h);
    ground.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    const rubbleTiles = [];
    const waterTiles = [];
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        const tile = t.tiles[y * t.w + x];
        const i = y * t.w + x;
        m4.makeTranslation(x + 0.5, 0, y + 0.5);
        ground.setMatrixAt(i, m4);
        col.set(TILE_COLOUR[tile] ?? TILE_COLOUR[T.grass]);
        if (tile === T.grass || tile === T.sand || tile === T.dirt) {
          col.offsetHSL(0, 0, (hash2(x, y) - 0.5) * 0.035);
        }
        ground.setColorAt(i, col);
        if (tile === T.rubble) rubbleTiles.push({ x, y });
        if (tile === T.water) waterTiles.push({ x, y });
      }
    }
    ground.instanceMatrix.needsUpdate = true;
    if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
    scene.add(ground);

    // Cobbles and tufts give the flat tile grid something to catch the dither.
    const cobbles = [];
    const tufts = [];
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        const tile = t.tiles[y * t.w + x];
        const r = hash2(x * 3.1, y * 5.7);
        if ((tile === T.road || tile === T.plaza) && r < 0.38) {
          cobbles.push({ x: x + 0.15 + hash2(x, y) * 0.7, z: y + 0.15 + hash2(y, x) * 0.7, s: 0.5 + hash2(x + 4, y) * 0.6 });
        }
        if ((tile === T.grass || tile === T.dirt) && r > 0.72 && r < 0.96) {
          tufts.push({ x: x + 0.2 + hash2(x + 2, y) * 0.6, z: y + 0.2 + hash2(x, y + 2) * 0.6, s: 0.7 + hash2(x, y + 7) * 0.7 });
        }
      }
    }
    if (cobbles.length) {
      const geo = new THREE.BoxGeometry(0.22, 0.045, 0.18);
      const mesh = new THREE.InstancedMesh(geo, mat('#7c7668', 1), cobbles.length);
      const c = new THREE.Color();
      cobbles.forEach((o, i) => {
        m4.makeRotationY(hash2(o.x, o.z) * 3.14);
        m4.setPosition(o.x, 0.02, o.z);
        m4.scale(new THREE.Vector3(o.s, 1, o.s));
        mesh.setMatrixAt(i, m4);
        c.set('#8b8576').offsetHSL(0, 0, (hash2(o.x, o.z) - 0.5) * 0.08);
        mesh.setColorAt(i, c);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
    if (tufts.length) {
      const geo = new THREE.ConeGeometry(0.035, 0.22, 4);
      geo.translate(0, 0.11, 0);
      const mesh = new THREE.InstancedMesh(geo, mat('#60754a', 1, 0, true), tufts.length);
      tufts.forEach((o, i) => {
        m4.makeRotationZ((hash2(o.x, o.z) - 0.5) * 0.4);
        m4.setPosition(o.x, 0, o.z);
        m4.scale(new THREE.Vector3(o.s, o.s, o.s));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }
  }

  function buildBackdrop() {
    const center = new THREE.Vector3(18, 0, 18);
    // distant hills: flattened, almost silhouettes
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.17;
      const r = 62 + hash2(i, 4) * 30;
      const hill = new THREE.Mesh(
        new THREE.DodecahedronGeometry(15, 0),
        mat(i % 3 === 0 ? '#273528' : '#223024', 1, 0, true),
      );
      hill.position.set(center.x + Math.cos(a) * r, -5 + hash2(i, 9) * 4, center.z + Math.sin(a) * r);
      hill.scale.set(1.4 + hash2(i, 2) * 1.2, 0.42 + hash2(i, 3) * 0.25, 1.1);
      hill.rotation.y = a;
      scene.add(hill);
    }
    // a dark pine belt just beyond the walkable edge
    const pines = [];
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2 + hash2(i, 11) * 0.1;
      const r = 23 + hash2(i, 5) * 12;
      pines.push({ x: center.x + Math.cos(a) * r, z: center.z + Math.sin(a) * r, s: 0.7 + hash2(i, 7) * 1.1 });
    }
    const geo = new THREE.ConeGeometry(1.5, 5.5, 6);
    geo.translate(0, 2.75, 0);
    const mesh = new THREE.InstancedMesh(geo, mat('#1b2a23', 1, 0, true), pines.length);
    const m4 = new THREE.Matrix4();
    pines.forEach((p, i) => {
      m4.makeRotationY(hash2(p.x, p.z) * 3.14);
      m4.setPosition(p.x, 0, p.z);
      m4.scale(new THREE.Vector3(p.s, p.s, p.s));
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }

  function buildRubble(t) {
    const rubble = [];
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) {
        if (t.tiles[y * t.w + x] !== T.rubble) continue;
        for (let k = 0; k < 2; k++) {
          rubble.push({
            x: x + 0.2 + hash2(x + k, y) * 0.6,
            z: y + 0.2 + hash2(y + k, x) * 0.6,
            s: 0.5 + hash2(x, y + k) * 0.85,
          });
        }
      }
    }
    if (!rubble.length) return;
    const geo = new THREE.DodecahedronGeometry(0.16, 0);
    const mesh = new THREE.InstancedMesh(geo, mat('#847d70', 1, 0, true), rubble.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    rubble.forEach((r, i) => {
      p.set(r.x, 0.08 + hash2(r.x, r.z) * 0.06, r.z);
      e.set(hash2(r.x, 1) * 3, hash2(r.z, 2) * 3, hash2(r.x, 3) * 3);
      q.setFromEuler(e);
      s.set(r.s, r.s * (0.5 + hash2(r.x, 4) * 0.35), r.s);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  function buildWater(t) {
    const waterTiles = [];
    for (let y = 0; y < t.h; y++) {
      for (let x = 0; x < t.w; x++) if (t.tiles[y * t.w + x] === T.water) waterTiles.push({ x, y });
    }
    if (!waterTiles.length) return;
    const waterGeo = new THREE.PlaneGeometry(1.02, 1.02);
    waterGeo.rotateX(-Math.PI / 2);
    const waterMat = new THREE.MeshStandardMaterial({
      color: 0x2d6871,
      roughness: 0.14,
      metalness: 0.2,
      transparent: true,
      opacity: 0.9,
    });
    waterUniforms = { uTime: { value: 0 } };
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = waterUniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           transformed.y += sin(position.x * 1.75 + uTime * 1.25) * 0.026
                          + cos(position.z * 2.05 + uTime * 0.95) * 0.021;`,
        );
    };
    waterMat.customProgramCacheKey = () => 'fenwick-water';
    waterMesh = new THREE.InstancedMesh(waterGeo, waterMat, waterTiles.length);
    waterMesh.receiveShadow = true;
    const m4 = new THREE.Matrix4();
    waterTiles.forEach((w, i) => {
      m4.makeTranslation(w.x + 0.5, 0.055, w.y + 0.5);
      waterMesh.setMatrixAt(i, m4);
    });
    waterMesh.instanceMatrix.needsUpdate = true;
    scene.add(waterMesh);
  }

  function buildPondDetails(t) {
    const water = new Set();
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) if (t.tiles[y * t.w + x] === T.water) water.add(`${x},${y}`);
    if (!water.size) return;

    const lilyMat = mat('#496b43', 0.9, 0, true);
    const reeds = [];
    const pads = [];
    for (const key of water) {
      const [x, y] = key.split(',').map(Number);
      const edge =
        !water.has(`${x + 1},${y}`) || !water.has(`${x - 1},${y}`) || !water.has(`${x},${y + 1}`) || !water.has(`${x},${y - 1}`);
      if (edge && hash2(x, y) < 0.55) reeds.push({ x: x + 0.2 + hash2(x, 1) * 0.6, z: y + 0.2 + hash2(y, 2) * 0.6 });
      if (!edge && hash2(x, y + 8) < 0.18) pads.push({ x: x + 0.3 + hash2(x, 3) * 0.4, z: y + 0.3 + hash2(y, 4) * 0.4 });
    }
    if (reeds.length) {
      const geo = new THREE.ConeGeometry(0.022, 0.8, 4);
      geo.translate(0, 0.4, 0);
      const mesh = new THREE.InstancedMesh(geo, mat('#687a48', 1, 0, true), reeds.length);
      const m4 = new THREE.Matrix4();
      reeds.forEach((r, i) => {
        m4.makeRotationZ((hash2(r.x, r.z) - 0.5) * 0.3);
        m4.setPosition(r.x, 0.02, r.z);
        m4.scale(new THREE.Vector3(1, 0.7 + hash2(r.x, 9) * 0.6, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }
    for (const p of pads) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(0.18, 7), lilyMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(p.x, 0.075, p.z);
      scene.add(pad);
    }
    // stones along the shore
    const stones = [];
    for (const key of water) {
      const [x, y] = key.split(',').map(Number);
      if (water.has(`${x},${y + 1}`)) continue;
      stones.push({ x: x + 0.15 + hash2(x, y) * 0.7, z: y + 0.95 });
    }
    if (stones.length) {
      const geo = new THREE.DodecahedronGeometry(0.2, 0);
      const mesh = new THREE.InstancedMesh(geo, mat('#777468', 1, 0, true), stones.length);
      const m4 = new THREE.Matrix4();
      stones.forEach((s, i) => {
        m4.makeRotationY(hash2(s.x, s.z) * 3);
        m4.setPosition(s.x, 0.05, s.z);
        m4.scale(new THREE.Vector3(1, 0.55, 1));
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      scene.add(mesh);
    }
  }

  function buildTrees(t) {
    const trees = t.props.filter((p) => p.kind === 'tree');
    if (!trees.length) return;
    const trunkGeo = new THREE.CylinderGeometry(0.07, 0.13, 1.0, 5);
    trunkGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, mat('#4d3a29', 1), trees.length);
    trunks.castShadow = true;

    const blobGeo = new THREE.IcosahedronGeometry(0.58, 0);
    const blobs = new THREE.InstancedMesh(blobGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, flatShading: true }), trees.length * 3);
    blobs.castShadow = true;
    blobs.receiveShadow = true;

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const leaf = new THREE.Color();
    let bi = 0;
    trees.forEach((tree, i) => {
      const scale = 0.8 + (tree.variant ?? 0) * 0.12 + hash2(tree.x, tree.y) * 0.2;
      p.set(tree.x + 0.5, 0, tree.y + 0.5);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(tree.x, tree.y) * 6.28);
      s.set(scale, scale, scale);
      m4.compose(p, q, s);
      trunks.setMatrixAt(i, m4);

      const offsets = [
        [-0.25, 1.22, 0.04, 1.0],
        [0.24, 1.42, 0.12, 0.78],
        [0.02, 1.68, -0.08, 0.62],
      ];
      for (let k = 0; k < 3; k++) {
        const o = offsets[k];
        p.set(tree.x + 0.5 + o[0] * scale, o[1] * scale, tree.y + 0.5 + o[2] * scale);
        e.set(hash2(tree.x + k, tree.y) * 3, hash2(tree.x, tree.y + k) * 3, hash2(tree.x, tree.y + k + 2) * 3);
        q.setFromEuler(e);
        const bs = scale * o[3];
        s.set(bs * (0.9 + hash2(k, tree.x) * 0.3), bs * (0.8 + hash2(k, tree.y) * 0.3), bs);
        m4.compose(p, q, s);
        blobs.setMatrixAt(bi, m4);
        leaf.setHSL(0.26 + hash2(tree.x, tree.y) * 0.035, 0.26, 0.22 + hash2(tree.x + k, tree.y) * 0.1);
        blobs.setColorAt(bi, leaf);
        bi++;
      }
    });
    trunks.instanceMatrix.needsUpdate = true;
    blobs.instanceMatrix.needsUpdate = true;
    if (blobs.instanceColor) blobs.instanceColor.needsUpdate = true;
    scene.add(trunks, blobs);
  }

  function buildFlowers(t) {
    const flowers = t.props.filter((p) => p.kind === 'flower');
    if (!flowers.length) return;
    const stemGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.22, 4);
    stemGeo.translate(0, 0.11, 0);
    const stems = new THREE.InstancedMesh(stemGeo, mat('#4e6b38', 1), flowers.length);
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.055, 6, 5), mat('#ffffff', 0.8), flowers.length);
    const palette = [0xd8b65a, 0xb87a96, 0xa9bcc4, 0xd8c7a0];
    const m4 = new THREE.Matrix4();
    const c = new THREE.Color();
    flowers.forEach((f, i) => {
      const px = f.x + 0.5 + Math.sin(f.y * 4.1) * 0.18;
      const pz = f.y + 0.5 + Math.cos(f.x * 3.7) * 0.18;
      m4.makeTranslation(px, 0, pz);
      stems.setMatrixAt(i, m4);
      m4.makeTranslation(px, 0.24, pz);
      heads.setMatrixAt(i, m4);
      c.set(palette[(f.variant ?? 0) % palette.length]);
      heads.setColorAt(i, c);
    });
    stems.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
    if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
    scene.add(stems, heads);
  }

  function buildBushes(t) {
    const spots = [];
    for (let y = 1; y < t.h - 1; y++) {
      for (let x = 1; x < t.w - 1; x++) {
        const tile = t.tiles[y * t.w + x];
        if (tile !== T.grass && tile !== T.dirt) continue;
        if (hash2(x * 1.7, y * 2.3) > 0.035) continue;
        spots.push({ x: x + 0.5, z: y + 0.5 });
      }
    }
    if (!spots.length) return;
    const geo = new THREE.DodecahedronGeometry(0.32, 0);
    const mesh = new THREE.InstancedMesh(geo, mat('#3e5838', 1, 0, true), spots.length);
    const m4 = new THREE.Matrix4();
    spots.forEach((s, i) => {
      m4.makeRotationY(hash2(s.x, s.z) * 3);
      m4.setPosition(s.x, 0.2, s.z);
      m4.scale(new THREE.Vector3(1, 0.7 + hash2(s.x, s.z) * 0.5, 1));
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    scene.add(mesh);
  }

  // ---------------------------------------------------------------- build: street furniture

  function buildLamp(prop) {
    const g = new THREE.Group();
    const x = prop.x + 0.5;
    const z = prop.y + 0.5;
    g.position.set(x, 0, z);
    const metal = mat('#23211d', 0.75, 0.35);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 0.14, 6), metal);
    base.position.y = 0.07;
    base.castShadow = true;
    g.add(base);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 2.3, 6), metal);
    post.position.y = 1.2;
    post.castShadow = true;
    g.add(post);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 5), metal);
    arm.position.set(0.24, 2.32, 0);
    arm.rotation.z = Math.PI / 2;
    g.add(arm);
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.015, 4, 8, Math.PI), metal);
    hook.position.set(0.5, 2.26, 0);
    g.add(hook);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xffe6b8,
      emissive: 0xffb45c,
      emissiveIntensity: 0.65,
      roughness: 0.35,
    });
    const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.22, 0.17), bulbMat);
    bulb.position.set(0.5, 2.12, 0);
    g.add(bulb);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.1, 4), metal);
    cap.position.set(0.5, 2.27, 0);
    cap.rotation.y = Math.PI / 4;
    g.add(cap);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0xffc070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.scale.setScalar(2.6);
    glow.position.set(0.5, 2.12, 0);
    g.add(glow);
    scene.add(g);
    lampPositions.push({ x: x + 0.5, z });
    lampGlows.push(glow.material);
    lampBulbs.push(bulbMat);
  }

  function buildBench(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const wood = mat('#5c422d', 0.96);
    const iron = mat('#25221e', 0.8, 0.25);
    for (let i = 0; i < 3; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.055, 0.1), wood);
      slat.position.set(0, 0.42, -0.12 + i * 0.13);
      slat.castShadow = true;
      g.add(slat);
    }
    for (let i = 0; i < 2; i++) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.1, 0.05), wood);
      back.position.set(0, 0.62 + i * 0.14, -0.17);
      back.rotation.x = -0.12;
      back.castShadow = true;
      g.add(back);
    }
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.44, 0.36), iron);
      leg.position.set(side * 0.44, 0.22, 0);
      g.add(leg);
      const backPost = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.05), iron);
      backPost.position.set(side * 0.44, 0.66, -0.17);
      backPost.rotation.x = -0.12;
      g.add(backPost);
    }
    scene.add(g);
  }

  function buildCrate(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const wood = mat('#705232', 0.95);
    const dark = mat('#4e3822', 1);
    const boxMesh = box(0.52, 0.46, 0.52, 0x705232, 0, 0.23, 0, g);
    boxMesh.material = wood;
    boxMesh.rotation.y = hash2(prop.x, prop.y) * 0.8;
    for (const y of [0.08, 0.4]) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 0.56), dark);
      rim.position.y = y;
      g.add(rim);
    }
    scene.add(g);
  }

  function buildGrave(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const stone = mat('#7d7a70', 0.98);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.14), stone);
    slab.position.y = 0.31;
    slab.rotation.z = (hash2(prop.x, prop.y) - 0.5) * 0.14;
    slab.castShadow = true;
    g.add(slab);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.21, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2), stone);
    top.rotation.z = Math.PI / 2;
    top.position.y = 0.62;
    g.add(top);
    scene.add(g);
  }

  function buildPayphone(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const shell = mat('#263236', 0.65, 0.3);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.45, 0.36), shell);
    body.position.y = 0.72;
    body.castShadow = true;
    g.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.13, 0.44), shell);
    roof.position.y = 1.5;
    g.add(roof);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(0.31, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x8fa4a5, emissive: 0x58787a, emissiveIntensity: 0.45, roughness: 0.3 }),
    );
    glass.position.set(0, 1.14, 0.185);
    g.add(glass);
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.28, 0.07), mat('#141616', 0.7));
    receiver.position.set(0.18, 1.0, 0.22);
    receiver.rotation.z = 0.2;
    g.add(receiver);
    scene.add(g);
  }

  function buildFountain(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const stone = mat('#8f897c', 0.93);
    const darkStone = mat('#6f6a60', 0.96);
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.12, 0.34, 10), stone);
    basin.position.y = 0.17;
    basin.castShadow = true;
    basin.receiveShadow = true;
    g.add(basin);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(1.08, 1.08, 0.09, 10), darkStone);
    rim.position.y = 0.35;
    g.add(rim);
    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(0.96, 0.96, 0.05, 10),
      new THREE.MeshStandardMaterial({ color: 0x3f7b85, roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.86 }),
    );
    water.position.y = 0.37;
    g.add(water);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.29, 0.9, 8), stone);
    column.position.y = 0.8;
    column.castShadow = true;
    g.add(column);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.54, 0.14, 8), stone);
    bowl.position.y = 1.25;
    bowl.castShadow = true;
    g.add(bowl);
    const bowlWater = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.04, 8), new THREE.MeshStandardMaterial({ color: 0x4e8c95, roughness: 0.14, metalness: 0.2 }));
    bowlWater.position.y = 1.33;
    g.add(bowlWater);
    const jet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.07, 0.5, 7),
      new THREE.MeshStandardMaterial({ color: 0xa3d2d4, transparent: true, opacity: 0.55, roughness: 0.1 }),
    );
    jet.position.y = 1.58;
    g.add(jet);
    // a small weather-worn fish on the top
    const fish = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), darkStone);
    fish.scale.set(1.5, 0.65, 0.5);
    fish.position.set(0, 1.82, 0);
    g.add(fish);
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.18, 4), darkStone);
    fin.rotation.z = -Math.PI / 2;
    fin.position.set(-0.18, 1.82, 0);
    g.add(fin);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0x9fd8df, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.scale.setScalar(2.2);
    glow.position.y = 1.25;
    g.add(glow);
    scene.add(g);
  }

  // ---------------------------------------------------------------- build: buildings

  function windowPlane(parent, x, y, z, rotY, width = 0.42, height = 0.62) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, height), windowMat);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    parent.add(m);
    return m;
  }

  function gableRoof(along, across, rise, roofMat, wallMat) {
    const g = new THREE.Group();
    const half = across / 2 + 0.18;
    const slope = Math.hypot(half, rise);
    const angle = Math.atan2(rise, half);
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(along + 0.55, 0.11, slope), roofMat);
      panel.position.set(0, rise / 2, (side * half) / 2);
      panel.rotation.x = side * angle;
      panel.castShadow = true;
      panel.receiveShadow = true;
      g.add(panel);
    }
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(along + 0.57, 0.1, 0.13), wallMat);
    ridge.position.y = rise;
    g.add(ridge);

    const shape = new THREE.Shape();
    shape.moveTo(-across / 2, 0);
    shape.lineTo(across / 2, 0);
    shape.lineTo(0, rise);
    shape.closePath();
    const endGeo = new THREE.ShapeGeometry(shape);
    for (const side of [-1, 1]) {
      const end = new THREE.Mesh(endGeo, wallMat);
      end.rotation.y = side * (Math.PI / 2);
      end.position.set((side * along) / 2, 0.01, 0);
      g.add(end);
    }
    return g;
  }

  function buildBuilding(place) {
    const rect = place.rect;
    const cx = rect.x + rect.w / 2;
    const cz = rect.y + rect.h / 2;
    const w = rect.w * 0.91;
    const h = rect.h * 0.91;
    const style = STYLE[place.id] ?? STYLE.nest;
    const height = style.height ?? 2.4 + (rect.w + rect.h) * 0.04;
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);

    const wallMat = mat(style.wall, 0.92);
    const trimMat = mat(style.trim, 0.88);
    const timberMat = mat(style.timber, 0.95);
    const roofMat = mat(style.roof, 0.86);
    const stepMat = mat('#777166', 0.98);

    const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.24, h + 0.16), stepMat);
    plinth.position.y = 0.12;
    plinth.receiveShadow = true;
    g.add(plinth);

    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, height, h), wallMat);
    walls.position.y = height / 2;
    walls.castShadow = true;
    walls.receiveShadow = true;
    g.add(walls);

    // corner posts and a horizontal beam: cheap timber framing, read at a glance
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        box(0.09, height, 0.09, style.timber, (sx * w) / 2, height / 2, (sz * h) / 2, g);
      }
    }
    for (const y of [0.32, height * 0.58, height - 0.16]) {
      const beamX = box(w + 0.04, 0.075, 0.06, style.timber, 0, y, h / 2 + 0.01, g);
      beamX.castShadow = false;
      const beamZ = box(0.06, 0.075, h + 0.04, style.timber, w / 2 + 0.01, y, 0, g);
      beamZ.castShadow = false;
    }

    // roof
    const rise = place.id === 'tower' ? 2.1 : 1.05 + (rect.w + rect.h) * 0.035;
    let roof;
    if (place.id === 'tower') {
      const spire = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, h) * 0.66, 2.6, 8), roofMat);
      spire.position.y = height + 1.3;
      spire.castShadow = true;
      g.add(spire);
      roof = spire;
    } else if (place.kind === 'public' && place.id === 'library') {
      const hip = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4), roofMat);
      hip.rotation.y = Math.PI / 4;
      hip.scale.set((w / 2 + 0.3) * 1.44, rise, (h / 2 + 0.3) * 1.44);
      hip.position.y = height + rise / 2;
      hip.castShadow = true;
      g.add(hip);
      roof = hip;
    } else {
      const along = Math.max(w, h);
      const across = Math.min(w, h);
      roof = gableRoof(along, across, rise, roofMat, wallMat);
      if (h > w) roof.rotation.y = Math.PI / 2;
      roof.position.y = height;
      g.add(roof);
    }

    // door side, from the simulation's own doorstep
    let doorSide = 's';
    if (place.door.y >= rect.y + rect.h) doorSide = 's';
    else if (place.door.y < rect.y) doorSide = 'n';
    else if (place.door.x < rect.x) doorSide = 'w';
    else doorSide = 'e';

    const hw = w / 2;
    const hh = h / 2;
    const sides = [
      { id: 'n', x: 0, z: -hh, rot: Math.PI, half: hw },
      { id: 's', x: 0, z: hh, rot: 0, half: hw },
      { id: 'w', x: -hw, z: 0, rot: -Math.PI / 2, half: hh },
      { id: 'e', x: hw, z: 0, rot: Math.PI / 2, half: hh },
    ];

    for (const side of sides) {
      const along = side.id === 's' || side.id === 'n' ? 'x' : 'z';
      const doorOffset =
        doorSide === side.id
          ? along === 'x'
            ? clamp(place.door.x + 0.5 - cx, -side.half + 0.6, side.half - 0.6)
            : clamp(place.door.y + 0.5 - cz, -side.half + 0.6, side.half - 0.6)
          : null;

      if (doorOffset !== null) buildDoor(g, side, doorOffset, along, place, style, height, trimMat, stepMat);

      const rows = height > 3 ? [height * 0.42, height * 0.7] : [height * 0.57];
      const count = side.half > 1.25 ? 2 : 1;
      for (const fy of rows) {
        for (let n = 0; n < count; n++) {
          const frac = count === 1 ? 0 : n === 0 ? -0.28 : 0.28;
          const offset = side.half * frac;
          if (doorOffset !== null && Math.abs(offset - doorOffset) < 0.52) continue;
          const wx = side.x + (along === 'x' ? offset : 0);
          const wz = side.z + (along === 'z' ? offset : 0);
          const nx = side.rot === Math.PI / 2 ? 1 : side.rot === -Math.PI / 2 ? -1 : 0;
          const nz = side.rot === 0 ? 1 : side.rot === Math.PI ? -1 : 0;
          const win = windowPlane(g, wx + nx * 0.015, fy, wz + nz * 0.015, side.rot);
          win.castShadow = false;
          const sill = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.055, 0.1), trimMat);
          sill.position.set(wx + nx * 0.045, fy - 0.34, wz + nz * 0.045);
          sill.rotation.y = side.rot;
          g.add(sill);
          if (place.kind === 'shop' && fy > 2 && hash2(offset, height) > 0.56) {
            const flower = new THREE.Mesh(new THREE.DodecahedronGeometry(0.085, 0), mat('#72804d', 1, 0, true));
            flower.position.set(wx + nx * 0.1, fy - 0.27, wz + nz * 0.1);
            g.add(flower);
          }
        }
      }
    }

    // chimneys, and the smoke anchors they carry
    if (place.id === 'nest' || place.id === 'bakery' || place.id === 'bar') {
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.05, 0.34), mat('#6d5542', 1));
      chimney.position.set(hw * 0.46, height + rise * 0.72, -hh * 0.3);
      chimney.castShadow = true;
      g.add(chimney);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.09, 0.43), trimMat);
      cap.position.set(chimney.position.x, chimney.position.y + 0.56, chimney.position.z);
      g.add(cap);
      smokeAnchors.push(new THREE.Vector3(cx + chimney.position.x, chimney.position.y + 0.7, cz + chimney.position.z));
      chimneyCount++;
    }

    if (place.id === 'tower') buildTowerDetails(g, cx, cz, height, w, trimMat, style);

    scene.add(g);
  }

  const smokeAnchors = [];

  function buildDoor(parent, side, offset, along, place, style, height, trimMat, stepMat) {
    const wx = side.x + (along === 'x' ? offset : 0);
    const wz = side.z + (along === 'z' ? offset : 0);
    const door = new THREE.Group();
    door.position.set(wx, 0, wz);
    door.rotation.y = side.rot;
    parent.add(door);

    const step = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.12, 0.34), stepMat);
    step.position.set(0, 0.06, 0.18);
    step.receiveShadow = true;
    door.add(step);

    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.28), doorMat);
    panel.position.set(0, 0.74, 0.012);
    door.add(panel);

    box(0.08, 1.38, 0.1, style.timber, -0.39, 0.69, 0.03, door);
    box(0.08, 1.38, 0.1, style.timber, 0.39, 0.69, 0.03, door);
    box(0.86, 0.1, 0.1, style.timber, 0, 1.38, 0.03, door);

    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.065, 7, 6), windowMat);
    lamp.position.set(0.47, 1.58, 0.06);
    door.add(lamp);

    if (place.kind === 'shop' || place.kind === 'public') {
      const awning = new THREE.Mesh(
        new THREE.PlaneGeometry(1.85, 0.82),
        new THREE.MeshStandardMaterial({ map: makeAwningTexture(style.accent), roughness: 0.9, side: THREE.DoubleSide }),
      );
      awning.rotation.x = -Math.PI / 2 + 0.34;
      awning.position.set(0, 1.82, 0.42);
      awning.castShadow = true;
      door.add(awning);
      for (const sx of [-1, 1]) {
        const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.75, 4), trimMat);
        bracket.position.set(sx * 0.83, 1.58, 0.35);
        bracket.rotation.x = 0.35;
        door.add(bracket);
      }
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.39), signMaterial(place));
      sign.position.set(0, 2.22, 0.08);
      door.add(sign);
    } else if (place.id === 'nest') {
      const wreath = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 5, 10), mat('#7e7642', 1));
      wreath.position.set(0, 1.55, 0.06);
      door.add(wreath);
    }
    void height;
  }

  function buildTowerDetails(g, cx, cz, height, w, trimMat, style) {
    // clock dials on two faces
    const clockTex = canvasTexture(128, 128, (ctx, cw, ch) => {
      ctx.fillStyle = '#d9cdb0';
      ctx.beginPath();
      ctx.arc(cw / 2, ch / 2, cw / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#3b352c';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = '#2d2922';
      ctx.lineWidth = 3;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cw / 2 + Math.cos(a) * 44, ch / 2 + Math.sin(a) * 44);
        ctx.lineTo(cw / 2 + Math.cos(a) * 52, ch / 2 + Math.sin(a) * 52);
        ctx.stroke();
      }
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(cw / 2, ch / 2);
      ctx.lineTo(cw / 2 + 18, ch / 2 - 22);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cw / 2, ch / 2);
      ctx.lineTo(cw / 2 - 28, ch / 2 + 8);
      ctx.lineWidth = 3;
      ctx.stroke();
    });
    const clockMat = new THREE.MeshStandardMaterial({ map: clockTex, roughness: 0.7, emissive: 0x3b2b16, emissiveIntensity: 0.1 });
    for (const rot of [0, Math.PI / 2]) {
      const dial = new THREE.Mesh(new THREE.CircleGeometry(0.52, 20), clockMat);
      dial.position.set(rot === 0 ? 0 : w / 2 + 0.012, height - 0.55, rot === 0 ? w / 2 + 0.012 : 0);
      dial.rotation.y = rot;
      g.add(dial);
    }

    // beacon: a dim rotating blade of light after dark
    const beacon = new THREE.Group();
    beacon.position.set(0, height + 2.9, 0);
    const bladeMat = new THREE.MeshBasicMaterial({
      color: 0xffc777,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const blade = new THREE.Mesh(new THREE.ConeGeometry(2.6, 14, 12, 1, true), bladeMat);
    blade.rotation.z = Math.PI / 2;
    blade.position.x = 7;
    beacon.add(blade);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffdda0, emissive: 0xffb45c, emissiveIntensity: 1 }));
    lamp.position.y = 0.1;
    beacon.add(lamp);
    g.add(beacon);
    towerBeacon.group = beacon;
    towerBeacon.material = bladeMat;
    void trimMat;
    void style;
    void cx;
    void cz;
  }

  // ---------------------------------------------------------------- build: set dressing

  function buildRuins(t) {
    const place = t.places.find((p) => p.id === 'ruins');
    if (!place) return;
    const stone = mat('#837c6f', 0.98);
    const dark = mat('#625d53', 1);
    const spots = [
      [4.4, 26.0, 1.2, 0.62],
      [8.8, 27.2, 0.8, 0.44],
      [6.2, 30.4, 1.5, 0.5],
      [9.4, 31.2, 0.6, 0.34],
      [3.8, 29.4, 0.9, 0.38],
    ];
    for (const [x, z, height, radius] of spots) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.88, radius, height, 7), stone);
      col.position.set(x, height / 2, z);
      col.rotation.z = (hash2(x, z) - 0.5) * 0.08;
      col.castShadow = true;
      col.receiveShadow = true;
      scene.add(col);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, 0.1, 7), dark);
      cap.position.set(x, height + 0.05, z);
      scene.add(cap);
    }
    // a surviving arch
    const arch = new THREE.Group();
    arch.position.set(6.8, 0, 28.4);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.46, 2.1, 0.5), stone);
      pillar.position.set(side * 0.72, 1.05, 0);
      pillar.castShadow = true;
      arch.add(pillar);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.2, 0.7), dark);
      foot.position.set(side * 0.72, 0.1, 0);
      arch.add(foot);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.34, 0.56), stone);
    lintel.position.y = 2.15;
    lintel.castShadow = true;
    arch.add(lintel);
    const capstone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 0.5, 4), dark);
    capstone.rotation.y = Math.PI / 4;
    capstone.position.y = 2.58;
    arch.add(capstone);
    scene.add(arch);
    // fallen blocks
    for (const [x, z, s] of [[5.4, 30.2, 0.7], [7.8, 31.0, 0.5], [4.2, 31.3, 0.4]]) {
      const block = new THREE.Mesh(new THREE.BoxGeometry(s, 0.32, s * 0.7), stone);
      block.position.set(x, 0.16, z);
      block.rotation.y = hash2(x, z) * 3;
      block.castShadow = true;
      scene.add(block);
    }
  }

  function buildDuck(t) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), mat('#cabf9f', 0.9));
    body.scale.set(1.3, 0.72, 0.9);
    body.position.y = 0.1;
    g.add(body);
    const neck = new THREE.Mesh(new THREE.SphereGeometry(0.105, 9, 7), mat('#2e493b', 0.88));
    neck.position.set(0, 0.26, 0.15);
    g.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 9, 7), mat('#2e493b', 0.88));
    head.position.set(0, 0.37, 0.21);
    g.add(head);
    const bill = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.12, 5), mat('#c79a45', 0.7));
    bill.rotation.x = Math.PI / 2;
    bill.position.set(0, 0.36, 0.3);
    g.add(bill);
    g.position.set(30.2, 0.06, 29.8);
    duck = g;
    duck.userData.phase = 0;
    scene.add(g);
    void t;
  }

  function buildExtras(t) {
    // market stalls
    for (const [x, z, rot] of [[25.2, 21.2, 0.2], [29.6, 22.2, -0.3]]) {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = rot;
      const wood = mat('#5a422d', 0.96);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1.9, 5), wood);
          post.position.set(sx * 0.55, 0.95, sz * 0.4);
          g.add(post);
        }
      }
      const canopy = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 1.1),
        new THREE.MeshStandardMaterial({ map: makeAwningTexture('#9c5b3e'), roughness: 0.95, side: THREE.DoubleSide }),
      );
      canopy.rotation.x = -Math.PI / 2 + 0.16;
      canopy.position.y = 1.9;
      canopy.castShadow = true;
      g.add(canopy);
      const table = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.08, 0.65), wood);
      table.position.y = 0.78;
      g.add(table);
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.75, 0.07), wood);
        leg.position.set(sx * 0.45, 0.38, 0);
        g.add(leg);
      }
      for (let i = 0; i < 4; i++) {
        const crate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.22), mat('#7a5a36', 1));
        crate.position.set(-0.35 + i * 0.23, 0.92 + (i % 2) * 0.08, (hash2(i, x) - 0.5) * 0.25);
        crate.rotation.y = hash2(i, z) * 0.8;
        g.add(crate);
      }
      scene.add(g);
    }

    // laundry line near the laundrette
    const line = new THREE.Group();
    line.position.set(8.1, 0, 22.4);
    for (const z of [-1.4, 1.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 2.0, 5), mat('#4e3b2b', 1));
      post.position.set(0, 1.0, z);
      line.add(post);
    }
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 2.8, 3), mat('#b4a58b', 1));
    rope.rotation.x = Math.PI / 2;
    rope.position.y = 1.85;
    line.add(rope);
    const cloths = ['#a9b7b0', '#c9b99a', '#8e5a45', '#8b9b8f'];
    cloths.forEach((c, i) => {
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.5), new THREE.MeshStandardMaterial({ color: c, roughness: 1, side: THREE.DoubleSide }));
      cloth.position.set(0, 1.55, -1.05 + i * 0.7);
      cloth.rotation.y = 0.1;
      line.add(cloth);
    });
    scene.add(line);

    // signpost at the plaza
    const signpost = new THREE.Group();
    signpost.position.set(18.8, 0, 19.6);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.2, 5), mat('#4a3526', 1));
    post.position.y = 1.1;
    signpost.add(post);
    for (const [label, y, dir] of [['POND', 1.75, 0.5], ['LIBRARY', 1.5, -2.5], ['MARKET', 1.25, 1.8]]) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.18, 0.05), mat('#6f5a3f', 0.95));
      board.position.set(Math.cos(dir) * 0.32, y, Math.sin(dir) * 0.32);
      board.rotation.y = -dir + Math.PI / 2;
      signpost.add(board);
      const text = new THREE.Mesh(
        new THREE.PlaneGeometry(0.72, 0.13),
        new THREE.MeshBasicMaterial({ map: makeSignTexture(label, '#d9c7a5'), transparent: true }),
      );
      text.position.copy(board.position);
      text.rotation.y = board.rotation.y;
      text.translateZ(0.032);
      signpost.add(text);
    }
    scene.add(signpost);

    // a low fence along the park edge, with an opening
    const fence = new THREE.Group();
    const fenceMat = mat('#57442f', 1);
    for (let x = 2.4; x <= 7.6; x += 0.55) {
      if (x > 4.6 && x < 5.5) continue;
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.05), fenceMat);
      p.position.set(x, 0.31, 23.15);
      fence.add(p);
    }
    for (const y of [0.3, 0.52]) {
      for (const [x1, x2] of [[2.4, 4.6], [5.5, 7.6]]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(x2 - x1, 0.04, 0.04), fenceMat);
        rail.position.set((x1 + x2) / 2, y, 23.15);
        fence.add(rail);
      }
    }
    scene.add(fence);

    // little jetty at the pond
    const jetty = new THREE.Group();
    jetty.position.set(31, 0, 33.5);
    const plankMat = mat('#5b4531', 0.97);
    for (let i = 0; i < 6; i++) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.07, 0.24), plankMat);
      plank.position.set(0, 0.16, -i * 0.33);
      plank.castShadow = true;
      jetty.add(plank);
    }
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.9, 5), mat('#3e3024', 1));
        pile.position.set(sx * 0.52, 0.1, -i * 1.3);
        jetty.add(pile);
      }
    }
    scene.add(jetty);
    void t;
  }

  function buildSmoke() {
    const perChimney = 3;
    for (const anchor of smokeAnchors) {
      for (let i = 0; i < perChimney; i++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: smokeTex,
            color: 0xbcb9a9,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            fog: true,
          }),
        );
        sprite.position.copy(anchor);
        sprite.scale.setScalar(0.35);
        scene.add(sprite);
        smokePuffs.push({ sprite, anchor, phase: i / perChimney + hash2(chimneyCount, i) * 0.2, drift: 0.15 + hash2(i, 3) * 0.15 });
      }
    }
  }

  function buildRain() {
    rainCount = 1300;
    rainPositions = new Float32Array(rainCount * 3);
    for (let i = 0; i < rainCount; i++) {
      rainPositions[i * 3] = player.x + (Math.random() - 0.5) * 30;
      rainPositions[i * 3 + 1] = Math.random() * 18;
      rainPositions[i * 3 + 2] = player.z + (Math.random() - 0.5) * 30;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
    rain = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xc6d5de,
        size: 0.055,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    rain.visible = false;
    rain.frustumCulled = false;
    scene.add(rain);
  }

  // ---------------------------------------------------------------- input

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let locked = false;

  function look(dx, dy) {
    player.yaw -= dx * 0.00215;
    player.pitch = clamp(player.pitch - dy * 0.00215, -1.42, 1.36);
  }

  window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    dragging = false;
    canvas.classList.remove('drag');
  });

  canvas.addEventListener('click', () => {
    if (!locked) {
      const request = canvas.requestPointerLock?.();
      if (request && typeof request.catch === 'function') request.catch(() => {});
    }
  });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    document.body.classList.toggle('locked', locked);
    canvas.classList.toggle('drag', locked);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (locked) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add('drag');
    canvas.focus();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
  });
  canvas.addEventListener('pointermove', (e) => {
    if (locked) {
      look(e.movementX || 0, e.movementY || 0);
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    look(dx * 2.1, dy * 2.1);
  });
  const endDrag = (e) => {
    dragging = false;
    canvas.classList.remove('drag');
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- collision

  function tileAt(x, z) {
    if (!town) return T.building;
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= town.w || iz >= town.h) return T.building;
    return town.tiles[iz * town.w + ix];
  }

  function walkable(x, z) {
    const t = tileAt(x, z);
    return t !== T.building && t !== T.water && t !== T.tree;
  }

  function blocked(x, z) {
    const r = 0.27;
    if (x < r || z < r || x > town.w - r || z > town.h - r) return true;
    if (!walkable(x, z)) return true;
    if (!walkable(x - r, z - r) || !walkable(x + r, z - r) || !walkable(x - r, z + r) || !walkable(x + r, z + r)) {
      return true;
    }
    for (const p of solidProps) {
      const dx = x - p.x;
      const dz = z - p.z;
      if (dx * dx + dz * dz < (p.r + r) * (p.r + r)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- movement

  function updatePlayer(dt) {
    const forward = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    const strafe = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    const running = keys.ShiftLeft || keys.ShiftRight;
    let dx = -Math.sin(player.yaw) * forward + Math.cos(player.yaw) * strafe;
    let dz = -Math.cos(player.yaw) * forward - Math.sin(player.yaw) * strafe;
    const len = Math.hypot(dx, dz);
    if (len > 1) {
      dx /= len;
      dz /= len;
    }
    const speed = running ? 5.2 : 2.8;
    const k = 1 - Math.exp(-dt * 11);
    player.vx = damp(player.vx, dx * speed, k);
    player.vz = damp(player.vz, dz * speed, k);
    if (Math.abs(player.vx) < 0.01) player.vx = 0;
    if (Math.abs(player.vz) < 0.01) player.vz = 0;

    const nx = player.x + player.vx * dt;
    if (!blocked(nx, player.z)) player.x = nx;
    else player.vx = 0;
    const nz = player.z + player.vz * dt;
    if (!blocked(player.x, nz)) player.z = nz;
    else player.vz = 0;

    const speedNow = Math.hypot(player.vx, player.vz);
    player.moving = damp(player.moving, speedNow > 0.3 ? 1 : 0, 1 - Math.exp(-dt * 8));
    player.phase += dt * (3.5 + speedNow * 2.4);
    player.roll = damp(player.roll, -strafe * Math.min(1, speedNow / 3) * 0.012, 1 - Math.exp(-dt * 7));

    const bob = player.moving * (Math.sin(player.phase * 2) * 0.019) + Math.sin(player.phase * 0.45) * 0.003;
    camera.position.set(player.x, player.eye + bob, player.z);
    camera.rotation.set(player.pitch, player.yaw, player.roll);

    const lantern = handLantern.userData;
    lantern.light.intensity = 0.16 + (snap?.darkness ?? 0) * 1.25;
    lantern.glow.opacity = 0.25 + (snap?.darkness ?? 0) * 0.5;
    handLantern.position.y = -0.31 + Math.sin(player.phase) * 0.006 * player.moving;
  }

  // ---------------------------------------------------------------- state

  function applyState(s) {
    if (!s || !s.creature) return;
    snap = s;
    const c = s.creature;
    mochi.x = c.x;
    mochi.z = c.y;
    mochi.moving = !!c.moving;
    mochi.asleep = !!c.asleep;
    const nextYaw = FACING_YAW[c.facing];
    if (typeof nextYaw === 'number') mochi.yaw = nextYaw;
    if (!mochi.placed) {
      mochi.placed = true;
      mochiGroup.position.set(mochi.x, 0, mochi.z);
      mochiGroup.rotation.y = mochi.yaw;
    }
    syncOfferings(s.offerings || []);

    $('day').textContent = String(s.day);
    $('time').textContent = s.time || '—';
    $('weather').textContent = s.weather || '—';

    if (townReady && !started) {
      started = true;
      hideLoading();
    }
  }

  function hideLoading() {
    $('loading').classList.add('gone');
  }

  fetch('/api/town')
    .then((r) => {
      if (!r.ok) throw new Error(`town responded ${r.status}`);
      return r.json();
    })
    .then((t) => buildWorld(t))
    .catch((err) => {
      const fail = $('fail');
      fail.style.display = 'flex';
      fail.textContent = `Could not load the town: ${err.message}. Is the world process running?`;
      $('loading').classList.add('gone');
    });

  let source = null;
  function connect() {
    try {
      source = new EventSource('/events');
      source.addEventListener('hello', (e) => {
        try {
          applyState(JSON.parse(e.data).state);
        } catch {}
      });
      source.addEventListener('state', (e) => {
        try {
          applyState(JSON.parse(e.data));
        } catch {}
      });
      source.onerror = () => {
        if (!snap) poll();
      };
    } catch {
      poll();
    }
  }
  let pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => applyState(s))
      .catch(() => {})
      .finally(() => {
        pollTimer = setTimeout(poll, 4000);
      });
  }
  connect();
  setTimeout(() => {
    if (!snap) poll();
  }, 2500);
  setTimeout(() => {
    if (!snap && !townReady) {
      const fail = $('fail');
      fail.style.display = 'flex';
      fail.textContent = 'The town is not answering. Check that the world process is running, then reload.';
      $('loading').classList.add('gone');
    }
  }, 12_000);

  // ---------------------------------------------------------------- offerings

  function syncOfferings(list) {
    const seen = new Set();
    for (const o of list) {
      if (!o || o.state === 'released' || !o.tile) continue;
      seen.add(o.id);
      if (crystalMeshes.has(o.id)) continue;
      const kept = o.state === 'kept';
      const colour = kept ? 0xe2b45c : 0x8fd6dd;
      const mesh = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.22, 0),
        new THREE.MeshStandardMaterial({
          color: colour,
          emissive: colour,
          emissiveIntensity: 1.1,
          roughness: 0.25,
          metalness: 0.15,
          transparent: true,
          opacity: 0.94,
        }),
      );
      mesh.position.set(o.tile.x + 0.5, 0.55, o.tile.y + 0.5);
      mesh.castShadow = true;
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: colour,
          transparent: true,
          opacity: 0.45,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.scale.setScalar(1.7);
      mesh.add(glow);
      scene.add(mesh);
      crystalMeshes.set(o.id, { mesh, base: 0.55, phase: Math.random() * Math.PI * 2 });
    }
    for (const [id, entry] of crystalMeshes) {
      if (seen.has(id)) continue;
      scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      crystalMeshes.delete(id);
    }
  }

  // ---------------------------------------------------------------- atmosphere

  const scratchTop = new THREE.Color();
  const scratchBottom = new THREE.Color();
  const scratchSun = new THREE.Color();
  const warm = new THREE.Color('#e8a86a');
  const nightTop = new THREE.Color('#060b14');
  const nightBottom = new THREE.Color('#111a24');

  function updateAtmosphere(now) {
    const dark = clamp(snap?.darkness ?? 0, 0, 1);
    const weather = snap?.weather ?? 'clear';
    const minutes = snap?.minutes ?? 480;
    const angle = (minutes / 1440) * Math.PI * 2 - Math.PI / 2;
    const elev = Math.sin(angle);
    const day = SKY_DAY[weather] ?? SKY_DAY.clear;

    scratchTop.set(day.top).lerp(nightTop, dark);
    scratchBottom.set(day.bottom).lerp(nightBottom, dark);

    const golden = Math.max(0, 1 - Math.abs(elev) / 0.3) * (1 - dark * 0.72);
    if (golden > 0.01) {
      scratchBottom.lerp(warm, golden * 0.55);
      scratchTop.lerp(warm, golden * 0.12);
    }
    skyUniforms.top.value.copy(scratchTop);
    skyUniforms.bottom.value.copy(scratchBottom);
    scene.fog.color.copy(scratchBottom);
    const targetFog = (FOG_BY_WEATHER[weather] ?? 0.01) * (1 + dark * 0.32);
    scene.fog.density = damp(scene.fog.density, targetFog, 0.04);

    const isDay = elev > 0.015;
    const sunPos = new THREE.Vector3(Math.cos(angle) * 60, elev * 60, 18);
    const moonPos = new THREE.Vector3(-Math.cos(angle) * 46, Math.max(12, -elev * 52), -22);
    if (isDay) {
      sun.position.copy(sunPos);
      scratchSun.set('#fff2d8').lerp(warm, clamp(1 - elev / 0.55, 0, 1) * 0.55);
      sun.color.copy(scratchSun);
      sun.intensity = (0.5 + elev * 2.0) * (LIGHT_BY_WEATHER[weather] ?? 1);
    } else {
      sun.position.copy(moonPos);
      sun.color.set('#a9c3e8');
      sun.intensity = 0.4 * (0.45 + dark * 0.55) * (LIGHT_BY_WEATHER[weather] ?? 1);
    }
    sun.target.position.set(18, 0, 18);
    sun.target.updateMatrixWorld();

    hemi.color.copy(scratchTop);
    hemi.groundColor.set('#363829');
    hemi.intensity = 0.28 + (1 - dark) * 0.66;
    ambient.intensity = 0.09 + (1 - dark) * 0.22;

    const sunDir = sunPos.clone().normalize().multiplyScalar(225);
    sunDisc.position.copy(sunDir);
    sunDisc.visible = isDay && weather === 'clear';
    const moonDir = moonPos.clone().normalize().multiplyScalar(225);
    moonDisc.position.copy(moonDir);
    moonDisc.visible = dark > 0.2 && weather !== 'fog';
    moonMat.opacity = clamp(dark * 1.2, 0, 1);
    moonGlow.material.opacity = 0.45 * dark;
    sunGlow.material.opacity = 0.5 * (1 - dark) * (weather === 'clear' ? 1 : 0.25);

    stars.material.opacity = dark * (weather === 'clear' ? 0.85 : weather === 'fog' ? 0.05 : 0.22);

    const winGlow = 0.03 + dark * 1.25;
    windowMat.emissiveIntensity = winGlow;
    for (const m of lampBulbs) m.emissiveIntensity = 0.45 + dark * 1.45;
    for (const g of lampGlows) g.opacity = dark * 0.82;
    mochiGroup.userData.light.intensity = dark * 0.7;

    for (const l of lampLights) l.intensity = 0;
    if (dark > 0.04 && lampPositions.length) {
      const nearest = lampPositions
        .map((p, i) => ({ i, d: (p.x - player.x) ** 2 + (p.z - player.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, lampLights.length);
      nearest.forEach((entry, index) => {
        const p = lampPositions[entry.i];
        const light = lampLights[index];
        light.position.set(p.x, 2.1, p.z);
        light.intensity = dark * 1.8;
      });
    }

    if (towerBeacon.group && towerBeacon.material) {
      towerBeacon.group.rotation.y = now / 5200;
      towerBeacon.material.opacity = dark * 0.1;
    }

    if (waterUniforms) waterUniforms.uTime.value = now / 1000;
    sky.position.set(camera.position.x, 0, camera.position.z);
    sunDisc.position.set(player.x + sunDir.x, sunDir.y, player.z + sunDir.z);
    moonDisc.position.set(player.x + moonDir.x, moonDir.y, player.z + moonDir.z);
  }

  // ---------------------------------------------------------------- animation

  function updateMochi(dt) {
    if (!mochi.placed) return;
    const k = 1 - Math.exp(-dt * 6);
    mochiGroup.position.x = damp(mochiGroup.position.x, mochi.x, k);
    mochiGroup.position.z = damp(mochiGroup.position.z, mochi.z, k);
    mochi.phase += dt * (mochi.moving ? 8 : 1.6);
    mochiGroup.position.y = mochi.asleep ? 0 : mochi.moving ? Math.abs(Math.sin(mochi.phase)) * 0.035 : Math.sin(mochi.phase) * 0.008;
    mochiGroup.rotation.y = dampAngle(mochiGroup.rotation.y, mochi.yaw, 1 - Math.exp(-dt * 7));

    const u = mochiGroup.userData;
    const speed = mochi.moving ? 1 : 0;
    u.legs.forEach((leg, i) => {
      const front = i % 2 === 0 ? 1 : -1;
      const side = i < 2 ? 1 : -1;
      leg.rotation.x = Math.sin(mochi.phase + (side > 0 ? 0 : Math.PI) + (front > 0 ? 0 : Math.PI)) * 0.32 * speed;
    });
    u.tail.rotation.y = Math.sin(mochi.phase * 0.7) * 0.18;
    u.tail.rotation.z = Math.sin(mochi.phase * 0.9 + 1) * 0.08;
    for (let i = 0; i < u.ears.length; i++) {
      u.ears[i].rotation.x = -0.08 + Math.sin(mochi.phase * 0.8 + i * 2) * 0.04;
    }
    const breathe = 1 + Math.sin(mochi.phase * 0.9) * 0.012;
    u.body.scale.set(1.0 * breathe, 1.12, 1.55);
    u.bell.rotation.z = Math.sin(mochi.phase * 1.3) * 0.12;

    const dist = Math.hypot(mochi.x - player.x, mochi.z - player.z);
    u.label.visible = dist < 10 && !mochi.asleep;
    u.label.material.opacity = clamp((10 - dist) / 5, 0, 0.9);
    u.light.intensity = (0.15 + (snap?.darkness ?? 0) * 0.6) * clamp(1 - dist / 9, 0, 1);
  }

  function updateOfferings(now) {
    for (const entry of crystalMeshes.values()) {
      entry.mesh.rotation.y = now / 1100 + entry.phase;
      entry.mesh.position.y = entry.base + Math.sin(now / 900 + entry.phase) * 0.09;
    }
  }

  function updateDuck(now) {
    if (!duck) return;
    const t = now / 1000;
    const angle = t * 0.14;
    duck.position.set(30.4 + Math.cos(angle) * 1.15, 0.06 + Math.sin(t * 1.3) * 0.01, 29.8 + Math.sin(angle) * 0.95);
    duck.rotation.y = -angle + Math.PI / 2;
    duck.rotation.z = Math.sin(t * 1.1) * 0.03;
  }

  function updateSmoke(now) {
    for (const puff of smokePuffs) {
      const cycle = (now / 1000 * puff.drift + puff.phase) % 1;
      const rise = cycle * 2.6;
      puff.sprite.position.set(
        puff.anchor.x + Math.sin(cycle * 5 + puff.phase) * 0.18 + cycle * 0.4,
        puff.anchor.y + rise,
        puff.anchor.z + Math.cos(cycle * 4 + puff.phase) * 0.14,
      );
      puff.sprite.scale.setScalar(0.28 + cycle * 0.75);
      puff.sprite.material.opacity = Math.sin(cycle * Math.PI) * 0.14;
    }
  }

  function updateRain(dt) {
    if (!rain) return;
    const raining = snap?.weather === 'rain' || snap?.weather === 'overcast';
    rain.visible = raining;
    if (!raining) return;
    const strength = snap?.weather === 'rain' ? 1 : 0.35;
    for (let i = 0; i < rainCount; i++) {
      const i3 = i * 3;
      rainPositions[i3 + 1] -= dt * (11 + (i % 7) * 0.7) * strength;
      rainPositions[i3] += dt * 1.1;
      if (
        rainPositions[i3 + 1] < 0 ||
        Math.abs(rainPositions[i3] - player.x) > 17 ||
        Math.abs(rainPositions[i3 + 2] - player.z) > 17
      ) {
        rainPositions[i3] = player.x + (Math.random() - 0.5) * 32;
        rainPositions[i3 + 1] = 10 + Math.random() * 10;
        rainPositions[i3 + 2] = player.z + (Math.random() - 0.5) * 32;
      }
    }
    rain.geometry.attributes.position.needsUpdate = true;
  }

  // ---------------------------------------------------------------- HUD

  function placeNameAt(x, z) {
    if (!town) return 'the street';
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    for (const p of town.places) {
      const r = p.rect;
      if (ix >= r.x && ix < r.x + r.w && iz >= r.y && iz < r.y + r.h) {
        if (p.kind === 'area' || p.id === 'plaza') return p.name;
        return `outside ${p.name}`;
      }
    }
    return 'the street';
  }

  let hudAt = 0;
  let lastPlace = '';
  let foundOnce = false;
  let toastTimer = null;

  function updateHud(now) {
    const dist = Math.hypot(mochi.x - player.x, mochi.z - player.z);
    const dx = mochi.x - player.x;
    const dz = mochi.z - player.z;
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const rx = Math.cos(player.yaw);
    const rz = -Math.sin(player.yaw);
    const forward = dx * fx + dz * fz;
    const right = dx * rx + dz * rz;
    const deg = (Math.atan2(right, forward) * 180) / Math.PI;
    $('arrow').style.transform = `rotate(${deg.toFixed(1)}deg)`;

    if (dist < 2.2 && !foundOnce) {
      foundOnce = true;
      showToast(mochi.asleep ? 'He is asleep, tucked into himself.' : 'You found Mochi.');
    } else if (dist > 8) {
      foundOnce = false;
    }

    if (now - hudAt < 140) return;
    hudAt = now;

    const stateLabel = mochi.asleep
      ? 'asleep'
      : snap?.creature?.action?.label
        ? snap.creature.action.label
        : mochi.moving
          ? 'walking'
          : 'sitting still';
    const tiles = Math.round(dist);
    $('dist').innerHTML = `${tiles}<span>${tiles === 1 ? 'tile' : 'tiles'} away</span>`;
    $('mstate').textContent = stateLabel;

    const near = dist < 4.2 && !mochi.asleep;
    $('near').classList.toggle('on', near);
    if (near) {
      $('near-label').textContent = snap?.creature?.action?.label || 'close by';
      $('near-thought').textContent = snap?.creature?.action?.thought || '';
    }

    const place = placeNameAt(player.x, player.z);
    if (place !== lastPlace) {
      lastPlace = place;
      $('place').textContent = place;
    }
  }

  function showToast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 3600);
  }

  // ---------------------------------------------------------------- frame

  let last = performance.now();

  function draw() {
    renderer.setRenderTarget(lowTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;

    if (town) {
      updatePlayer(dt);
      updateAtmosphere(now);
      updateMochi(dt);
      updateOfferings(now);
      updateDuck(now);
      updateSmoke(now);
      updateRain(dt);
      updateHud(now);
    } else {
      camera.position.set(player.x, player.eye, player.z);
      camera.rotation.set(player.pitch, player.yaw, 0);
    }

    postUniforms.uTime.value = now / 1000;
    draw();
  }

  renderer.setAnimationLoop(frame);
  camera.position.set(player.x, player.eye, player.z);

  // A small, read-only handle used by the smoke test to prove the dither pass
  // is actually producing a limited palette and that the camera is first person.
  window.__fenwick = {
    get ready() {
      return townReady && Boolean(snap);
    },
    get player() {
      return { x: player.x, z: player.z, yaw: player.yaw, pitch: player.pitch, eye: player.eye };
    },
    get render() {
      return { lowW, lowH, palette: PALETTE_N, firstPerson: true, meshes: scene.children.length };
    },
    get stats() {
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
    sample() {
      draw();
      const gl = renderer.getContext();
      const w = Math.min(96, renderer.domElement.width);
      const h = Math.min(96, renderer.domElement.height);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(
        Math.max(0, Math.floor((renderer.domElement.width - w) / 2)),
        Math.max(0, Math.floor((renderer.domElement.height - h) / 2)),
        w,
        h,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        px,
      );
      const colours = new Set();
      for (let i = 0; i < px.length; i += 4) colours.add(`${px[i]},${px[i + 1]},${px[i + 2]}`);
      return { colours: colours.size, glError: gl.getError() };
    },
  };
})();
