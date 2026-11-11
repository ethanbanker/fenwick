/* Fenwick, third person. You are a visitor walking through the town: WASD,
   shift to run, space to jump, drag to look, wheel to zoom. Mochi is out there
   living his own day, tracked live over SSE. Nothing here changes him — this
   is a window you can walk around inside. */

import * as THREE from '/vendor/three.module.min.js';

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('scene');

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const damp = (a, b, k) => a + (b - a) * k;
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const dampAngle = (a, b, k) => a + wrapPi(b - a) * k;

  /* tile codes, mirrored from src/world/map.ts */
  const T = { grass: 0, road: 1, water: 2, plaza: 3, building: 4, tree: 5, rubble: 6, sand: 7, dirt: 8 };
  const TILE_COLOUR = [
    '#56763f', // grass
    '#7a7468', // road
    '#2b5560', // water (only seen under the surface)
    '#9a9182', // plaza
    '#6b6458', // building footprint
    '#3f5c34', // tree / grass under it
    '#7c7569', // rubble
    '#c2ae86', // sand
    '#75624a', // dirt
  ];
  const FACING_YAW = { e: Math.PI / 2, s: 0, w: -Math.PI / 2, n: Math.PI };
  const SKY_DAY = {
    clear: { top: '#5a83ab', bottom: '#d2dad6' },
    overcast: { top: '#727d87', bottom: '#bfc5c4' },
    rain: { top: '#4a555f', bottom: '#8b959a' },
    fog: { top: '#97a19e', bottom: '#cbd1cd' },
    wind: { top: '#60839d', bottom: '#cbd5d4' },
  };
  const FOG_BY_WEATHER = { clear: 0.008, overcast: 0.013, rain: 0.021, fog: 0.044, wind: 0.01 };
  const LIGHT_BY_WEATHER = { clear: 1, overcast: 0.62, rain: 0.38, fog: 0.34, wind: 0.92 };

  // ---------------------------------------------------------------- renderer

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    const fail = $('fail');
    fail.style.display = 'flex';
    fail.textContent = `This browser could not start WebGL, so the town cannot be drawn. (${err.message})`;
    $('loading').classList.add('gone');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9aa29c, 0.012);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 620);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- sky

  const skyUniforms = {
    top: { value: new THREE.Color('#5a83ab') },
    bottom: { value: new THREE.Color('#d2dad6') },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 32, 18),
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
          float t = pow(clamp(h, 0.0, 1.0), 0.55);
          gl_FragColor = vec4(mix(bottom, top, t), 1.0);
        }`,
    }),
  );
  sky.frustumCulled = false;
  scene.add(sky);

  // stars, only after dark
  {
    const count = 900;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const y = Math.random() * 0.9 + 0.06;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * r * 260;
      pos[i * 3 + 1] = y * 260;
      pos[i * 3 + 2] = Math.sin(a) * r * 260;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var stars = new THREE.Points(
      g,
      new THREE.PointsMaterial({
        color: 0xdbe6ff,
        size: 1.15,
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

  const hemi = new THREE.HemisphereLight(0xbfd3e2, 0x3a392c, 1.0);
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(0x4a5662, 0.3);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -25;
  sun.shadow.camera.right = 25;
  sun.shadow.camera.top = 25;
  sun.shadow.camera.bottom = -25;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.bias = -0.0007;
  sun.shadow.normalBias = 0.02;
  sun.target.position.set(18, 0, 18);
  scene.add(sun, sun.target);

  const celestial = new THREE.Group();
  const discMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 1, fog: false });
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(5.4, 18, 12), discMat);
  const moonMat = new THREE.MeshBasicMaterial({ color: 0xe4edfa, transparent: true, opacity: 0, fog: false });
  const moonDisc = new THREE.Mesh(new THREE.SphereGeometry(4.0, 18, 12), moonMat);
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

  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: 0xffd9a0, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  sunGlow.scale.setScalar(52);
  sunDisc.add(sunGlow);
  const moonGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: 0xcfe0ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  moonGlow.scale.setScalar(40);
  moonDisc.add(moonGlow);

  // ---------------------------------------------------------------- player

  const player = {
    x: 17.5,
    z: 20.5,
    y: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    yaw: 0,
    targetYaw: 0,
    phase: 0,
    onGround: true,
  };
  const cam = { yaw: 0.35, pitch: 0.34, dist: 7.2, want: 7.2, look: new THREE.Vector3(), ready: false };

  function makePlayer() {
    const g = new THREE.Group();
    const coat = new THREE.MeshStandardMaterial({ color: 0x3f5666, roughness: 0.92 });
    const coatDark = new THREE.MeshStandardMaterial({ color: 0x2f424f, roughness: 0.95 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc99a76, roughness: 0.82 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x2a211b, roughness: 1 });
    const scarf = new THREE.MeshStandardMaterial({ color: 0xb87544, roughness: 0.9 });
    const boot = new THREE.MeshStandardMaterial({ color: 0x2b2620, roughness: 1 });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.54, 4, 10), coat);
    body.position.y = 0.84;
    body.castShadow = true;
    g.add(body);

    const fringe = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.2, 10), coatDark);
    fringe.position.y = 0.52;
    g.add(fringe);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 12), skin);
    head.position.y = 1.31;
    head.castShadow = true;
    g.add(head);

    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    cap.position.y = 1.33;
    cap.castShadow = true;
    g.add(cap);

    const neck = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.055, 6, 14), scarf);
    neck.rotation.x = Math.PI / 2;
    neck.position.y = 1.13;
    g.add(neck);
    const scarfTail = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.3, 0.05), scarf);
    scarfTail.position.set(0.08, 1.0, 0.18);
    g.add(scarfTail);

    const limbGeo = new THREE.CapsuleGeometry(0.065, 0.34, 3, 8);
    const arms = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(limbGeo, coat);
      arm.position.set(side * 0.28, 0.96, 0);
      arm.castShadow = true;
      g.add(arm);
      arms.push(arm);
    }
    const legGeo = new THREE.CapsuleGeometry(0.075, 0.36, 3, 8);
    const legs = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, coatDark);
      leg.position.set(side * 0.1, 0.32, 0);
      leg.castShadow = true;
      g.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.22), boot);
      foot.position.set(side * 0.1, 0.045, 0.05);
      g.add(foot);
      legs.push(leg);
    }

    // a little lantern, so the night streets are walkable
    const lampArm = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.24, 5), coatDark);
    lampArm.position.set(0.38, 0.85, 0.08);
    const lantern = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.17, 0.13),
      new THREE.MeshStandardMaterial({ color: 0xffcf8a, emissive: 0xffb45c, emissiveIntensity: 1.4, roughness: 0.5 }),
    );
    lantern.position.set(0.38, 0.68, 0.08);
    g.add(lampArm, lantern);
    const lanternGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0xffc880, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    lanternGlow.scale.setScalar(1.25);
    lanternGlow.position.copy(lantern.position);
    g.add(lanternGlow);

    const light = new THREE.PointLight(0xffc887, 0.55, 5.5, 2);
    light.position.set(0.38, 0.8, 0.08);
    g.add(light);

    g.userData = { arms, legs, lantern, light };
    return g;
  }
  const playerGroup = makePlayer();
  playerGroup.position.set(player.x, 0, player.z);
  scene.add(playerGroup);

  // ---------------------------------------------------------------- mochi

  function makeLabel(text) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '600 56px Georgia, "Times New Roman", serif';
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillText(text, 257, 67);
    g.fillStyle = '#fff2da';
    g.fillText(text, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function makeOwl() {
    const g = new THREE.Group();
    const feather = new THREE.MeshStandardMaterial({ color: 0x80603f, roughness: 0.95 });
    const light = new THREE.MeshStandardMaterial({ color: 0xc4a87e, roughness: 0.95 });
    const beak = new THREE.MeshStandardMaterial({ color: 0xd99a47, roughness: 0.7 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf1e8d6, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x171412, roughness: 0.6 });
    const amberEye = new THREE.MeshStandardMaterial({ color: 0xe0a53a, emissive: 0x8a5a10, emissiveIntensity: 0.5, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.33, 16, 14), feather);
    body.scale.set(1, 1.1, 0.92);
    body.position.y = 0.47;
    body.castShadow = true;
    g.add(body);

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.26, 14, 12), light);
    belly.scale.set(1, 1.02, 0.62);
    belly.position.set(0, 0.43, 0.13);
    g.add(belly);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 14), feather);
    head.position.y = 0.94;
    head.castShadow = true;
    g.add(head);

    for (const side of [-1, 1]) {
      const disc = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), light);
      disc.scale.set(1, 1.1, 0.45);
      disc.position.set(side * 0.105, 0.98, 0.19);
      g.add(disc);

      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.078, 12, 10), white);
      eye.position.set(side * 0.105, 0.99, 0.245);
      g.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.043, 10, 8), dark);
      pupil.position.set(side * 0.105, 0.99, 0.305);
      g.add(pupil);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 5), white);
      glint.position.set(side * 0.09, 1.005, 0.34);
      g.add(glint);

      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 7), amberEye);
      iris.scale.z = 0.4;
      iris.position.set(side * 0.105, 0.99, 0.298);
      g.add(iris);

      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.19, 6), feather);
      tuft.position.set(side * 0.15, 1.15, -0.015);
      tuft.rotation.z = side * -0.3;
      g.add(tuft);

      const wing = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 10), feather);
      wing.scale.set(0.3, 1.05, 0.72);
      wing.position.set(side * 0.31, 0.5, -0.01);
      wing.castShadow = true;
      g.add(wing);
      g.userData[side < 0 ? 'wingL' : 'wingR'] = wing;

      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.16), beak);
      foot.position.set(side * 0.1, 0.035, 0.09);
      g.add(foot);
    }

    const beakMesh = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.14, 4), beak);
    beakMesh.rotation.x = Math.PI / 2;
    beakMesh.position.set(0, 0.89, 0.32);
    g.add(beakMesh);

    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 6), feather);
    tail.rotation.x = 2.5;
    tail.position.set(0, 0.34, -0.28);
    g.add(tail);

    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeLabel('Mochi'), transparent: true, depthWrite: false, depthTest: true }),
    );
    label.scale.set(1.7, 0.425, 1);
    label.position.set(0, 1.62, 0);
    g.add(label);
    g.userData.label = label;

    const glow = new THREE.PointLight(0xffbf78, 0, 4, 2);
    glow.position.set(0, 0.7, 0.2);
    g.add(glow);
    g.userData.light = glow;

    return g;
  }

  const mochiGroup = makeOwl();
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

  // ---------------------------------------------------------------- world

  let town = null;
  let snap = null;
  let townReady = false;
  let started = false;
  const solidProps = [];
  const lampPositions = [];
  const lampGlows = [];
  const lampBulbs = [];
  const windowMats = [];
  const crystalMeshes = new Map();
  const lampLights = [];
  let waterUniforms = null;
  let waterMesh = null;
  let duck = null;
  let rain = null;
  let rainPositions = null;
  let rainCount = 0;

  function makeLampLightPool() {
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffb765, 0, 9, 2);
      scene.add(l);
      lampLights.push(l);
    }
  }

  function buildWorld(t) {
    town = t;
    player.x = t.spawn.x + 0.5;
    player.z = t.spawn.y + 0.5;
    playerGroup.position.set(player.x, 0, player.z);

    // ---- ground, one instanced plane per tile
    const groundGeo = new THREE.PlaneGeometry(1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 });
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
          col.offsetHSL(0, 0, (Math.sin(x * 12.9 + y * 7.3) + 1) * 0.02 - 0.02);
        }
        ground.setColorAt(i, col);
        if (tile === T.rubble) rubbleTiles.push({ x, y });
        if (tile === T.water) waterTiles.push({ x, y });
      }
    }
    ground.instanceMatrix.needsUpdate = true;
    if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
    scene.add(ground);

    // ---- rubble rocks
    if (rubbleTiles.length) {
      const rockGeo = new THREE.DodecahedronGeometry(0.17, 0);
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b8478, roughness: 1 });
      const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rubbleTiles.length * 2);
      rocks.castShadow = true;
      rocks.receiveShadow = true;
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      let n = 0;
      for (const rt of rubbleTiles) {
        for (let k = 0; k < 2; k++) {
          p.set(rt.x + 0.2 + Math.random() * 0.6, 0.08 + Math.random() * 0.06, rt.y + 0.2 + Math.random() * 0.6);
          e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
          q.setFromEuler(e);
          const sc = 0.5 + Math.random() * 0.75;
          s.set(sc, sc * (0.5 + Math.random() * 0.4), sc);
          m4.compose(p, q, s);
          rocks.setMatrixAt(n++, m4);
        }
      }
      rocks.instanceMatrix.needsUpdate = true;
      scene.add(rocks);
    }

    // ---- water, with a slow ripple in the vertex shader
    if (waterTiles.length) {
      const waterGeo = new THREE.PlaneGeometry(1.015, 1.015);
      waterGeo.rotateX(-Math.PI / 2);
      const waterMat = new THREE.MeshStandardMaterial({
        color: 0x3d7d8b,
        roughness: 0.16,
        metalness: 0.15,
        transparent: true,
        opacity: 0.84,
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
      let i = 0;
      for (const w of waterTiles) {
        m4.makeTranslation(w.x + 0.5, 0.055, w.y + 0.5);
        waterMesh.setMatrixAt(i++, m4);
      }
      waterMesh.instanceMatrix.needsUpdate = true;
      scene.add(waterMesh);
    }

    // ---- trees, instanced trunks and two cones each
    const trees = t.props.filter((p) => p.kind === 'tree');
    if (trees.length) {
      const trunkGeo = new THREE.CylinderGeometry(0.075, 0.12, 0.85, 5);
      trunkGeo.translate(0, 0.425, 0);
      const trunkMesh = new THREE.InstancedMesh(
        trunkGeo,
        new THREE.MeshStandardMaterial({ color: 0x5b4630, roughness: 1 }),
        trees.length,
      );
      trunkMesh.castShadow = true;
      const coneGeo = new THREE.ConeGeometry(0.62, 1.2, 7);
      const leafMesh = new THREE.InstancedMesh(
        coneGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }),
        trees.length * 2,
      );
      leafMesh.castShadow = true;
      leafMesh.receiveShadow = true;
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const leafCol = new THREE.Color();
      let li = 0;
      trees.forEach((tree, i) => {
        const scale = 0.82 + ((tree.variant ?? 0) % 3) * 0.14 + (Math.sin(tree.x * 3.1 + tree.y * 1.7) + 1) * 0.06;
        p.set(tree.x + 0.5, 0, tree.y + 0.5);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (tree.x * 1.7 + tree.y) % 6.28);
        s.set(scale, scale, scale);
        m4.compose(p, q, s);
        trunkMesh.setMatrixAt(i, m4);

        for (let k = 0; k < 2; k++) {
          const cs = scale * (k === 0 ? 1 : 0.7);
          p.set(tree.x + 0.5, 1.02 + k * 0.52, tree.y + 0.5);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (tree.x + tree.y * 2 + k) % 6.28);
          s.set(cs, cs, cs);
          m4.compose(p, q, s);
          leafMesh.setMatrixAt(li, m4);
          leafCol.setHSL(0.27 + ((tree.variant ?? 0) * 0.017 + k * 0.008), 0.32, 0.28 + scale * 0.06);
          leafMesh.setColorAt(li, leafCol);
          li++;
        }
      });
      trunkMesh.instanceMatrix.needsUpdate = true;
      leafMesh.instanceMatrix.needsUpdate = true;
      if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
      scene.add(trunkMesh, leafMesh);
    }

    // ---- flowers
    const flowers = t.props.filter((p) => p.kind === 'flower');
    if (flowers.length) {
      const stemGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.2, 4);
      stemGeo.translate(0, 0.1, 0);
      const stems = new THREE.InstancedMesh(
        stemGeo,
        new THREE.MeshStandardMaterial({ color: 0x4e6b38, roughness: 1 }),
        flowers.length,
      );
      const headGeo = new THREE.SphereGeometry(0.055, 6, 5);
      const heads = new THREE.InstancedMesh(
        headGeo,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
        flowers.length,
      );
      const petal = new THREE.Color();
      const palette = [0xe0c060, 0xc07aa0, 0xb9c8d8];
      flowers.forEach((f, i) => {
        const px = f.x + 0.5 + Math.sin(f.y * 4.1) * 0.18;
        const pz = f.y + 0.5 + Math.cos(f.x * 3.7) * 0.18;
        m4.makeTranslation(px, 0, pz);
        stems.setMatrixAt(i, m4);
        m4.makeTranslation(px, 0.22, pz);
        heads.setMatrixAt(i, m4);
        petal.set(palette[(f.variant ?? 0) % palette.length]);
        heads.setColorAt(i, petal);
      });
      stems.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
      if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
      scene.add(stems, heads);
    }

    // ---- street furniture
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
      solidProps.push({
        x: prop.x + 0.5,
        z: prop.y + 0.5,
        r: prop.kind === 'fountain' ? 0.95 : 0.38,
      });
    }

    // ---- buildings
    for (const place of t.places) {
      if (place.kind !== 'area') buildBuilding(place);
    }

    buildRuins(t);
    buildDuck(t);

    // ---- rain
    buildRain();

    townReady = true;
    $('sub').textContent = `you are walking through ${t.townName ?? 'the town'}`;
    if (snap) hideLoading();
  }

  function buildLamp(prop) {
    const g = new THREE.Group();
    const x = prop.x + 0.5;
    const z = prop.y + 0.5;
    g.position.set(x, 0, z);
    const metal = new THREE.MeshStandardMaterial({ color: 0x23211d, roughness: 0.8, metalness: 0.3 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.06, 1.85, 6), metal);
    post.position.y = 0.925;
    post.castShadow = true;
    g.add(post);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.13, 6), metal);
    cap.position.y = 2.02;
    g.add(cap);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xffe6b8,
      emissive: 0xffb45c,
      emissiveIntensity: 0.8,
      roughness: 0.4,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 7), bulbMat);
    bulb.position.y = 1.94;
    g.add(bulb);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xffc070,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.scale.setScalar(2.8);
    glow.position.y = 1.94;
    g.add(glow);
    scene.add(g);
    lampPositions.push({ x, z });
    lampGlows.push(glow.material);
    lampBulbs.push(bulbMat);
  }

  function buildBench(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const wood = new THREE.MeshStandardMaterial({ color: 0x6f4d33, roughness: 0.96 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x2b2723, roughness: 0.8, metalness: 0.2 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.08, 0.34), wood);
    seat.position.y = 0.4;
    seat.castShadow = true;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.3, 0.06), wood);
    back.position.set(0, 0.57, -0.15);
    back.castShadow = true;
    g.add(back);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.3), iron);
      leg.position.set(side * 0.4, 0.2, 0);
      g.add(leg);
    }
    scene.add(g);
  }

  function buildCrate(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const wood = new THREE.MeshStandardMaterial({ color: 0x7d5c39, roughness: 0.95 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.46, 0.52), wood);
    box.position.y = 0.23;
    box.rotation.y = (prop.x * 0.7) % 0.7;
    box.castShadow = true;
    box.receiveShadow = true;
    g.add(box);
    const slat = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.55), new THREE.MeshStandardMaterial({ color: 0x5f4529, roughness: 1 }));
    slat.position.y = 0.42;
    g.add(slat);
    scene.add(g);
  }

  function buildGrave(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a857b, roughness: 0.98 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.62, 0.14), stone);
    slab.position.y = 0.31;
    slab.castShadow = true;
    g.add(slab);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2), stone);
    top.rotation.z = Math.PI / 2;
    top.position.y = 0.62;
    g.add(top);
    scene.add(g);
  }

  function buildPayphone(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const shell = new THREE.MeshStandardMaterial({ color: 0x2c3438, roughness: 0.7, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.44, 1.35, 0.34), shell);
    body.position.y = 0.68;
    body.castShadow = true;
    g.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.42), shell);
    roof.position.y = 1.4;
    g.add(roof);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x9fb5b8, emissive: 0x5a7a7c, emissiveIntensity: 0.5, roughness: 0.3 }),
    );
    glass.position.set(0, 1.05, 0.175);
    g.add(glass);
    scene.add(g);
  }

  function buildFountain(prop) {
    const g = new THREE.Group();
    g.position.set(prop.x + 0.5, 0, prop.y + 0.5);
    const stone = new THREE.MeshStandardMaterial({ color: 0x9b9487, roughness: 0.9 });
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.08, 0.32, 18), stone);
    basin.position.y = 0.16;
    basin.castShadow = true;
    basin.receiveShadow = true;
    g.add(basin);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(1.04, 1.04, 0.08, 18), stone);
    rim.position.y = 0.33;
    g.add(rim);
    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(0.94, 0.94, 0.05, 18),
      new THREE.MeshStandardMaterial({ color: 0x4a8a97, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.85 }),
    );
    water.position.y = 0.34;
    g.add(water);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.85, 10), stone);
    column.position.y = 0.75;
    column.castShadow = true;
    g.add(column);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.52, 0.14, 12), stone);
    bowl.position.y = 1.18;
    bowl.castShadow = true;
    g.add(bowl);
    const jet = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.075, 0.55, 8),
      new THREE.MeshStandardMaterial({ color: 0x9dd2d8, transparent: true, opacity: 0.55, roughness: 0.1 }),
    );
    jet.position.y = 1.5;
    g.add(jet);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: 0x9fd8df, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.scale.setScalar(2.2);
    glow.position.y = 1.2;
    g.add(glow);
    scene.add(g);
  }

  function buildRoof(w, h, height, place) {
    const roofHeight = place.id === 'tower' ? 1.9 : 1.05;
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(1, 1, 4),
      new THREE.MeshStandardMaterial({ color: place.palette.roof, roughness: 0.85 }),
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set((w / 2 + 0.16) * 1.42, roofHeight, (h / 2 + 0.16) * 1.42);
    roof.position.y = height + roofHeight / 2;
    roof.castShadow = true;
    roof.receiveShadow = true;
    return roof;
  }

  function buildBuilding(place) {
    const rect = place.rect;
    const cx = rect.x + rect.w / 2;
    const cz = rect.y + rect.h / 2;
    const w = rect.w * 0.94;
    const h = rect.h * 0.94;
    const height = place.id === 'tower' ? 4.4 : 2.35 + (rect.w + rect.h) * 0.045;

    const g = new THREE.Group();
    g.position.set(cx, 0, cz);

    const wallMat = new THREE.MeshStandardMaterial({ color: place.palette.wall, roughness: 0.9 });
    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, height, h), wallMat);
    walls.position.y = height / 2;
    walls.castShadow = true;
    walls.receiveShadow = true;
    g.add(walls);

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.11, 0.2, h + 0.11),
      new THREE.MeshStandardMaterial({ color: place.palette.trim, roughness: 0.95 }),
    );
    plinth.position.y = 0.1;
    plinth.receiveShadow = true;
    g.add(plinth);

    g.add(buildRoof(w, h, height, place));

    const hw = w / 2;
    const hh = h / 2;
    let doorSide = 's';
    if (place.door.y >= rect.y + rect.h) doorSide = 's';
    else if (place.door.y < rect.y) doorSide = 'n';
    else if (place.door.x < rect.x) doorSide = 'w';
    else doorSide = 'e';

    const sides = [
      { id: 'n', x: 0, z: -hh, rot: Math.PI, half: hw },
      { id: 's', x: 0, z: hh, rot: 0, half: hw },
      { id: 'w', x: -hw, z: 0, rot: -Math.PI / 2, half: hh },
      { id: 'e', x: hw, z: 0, rot: Math.PI / 2, half: hh },
    ];

    const trimMat = new THREE.MeshStandardMaterial({ color: place.palette.trim, roughness: 0.82 });
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x2a2b28,
      emissive: 0xffc477,
      emissiveIntensity: 0.08,
      roughness: 0.35,
    });
    windowMats.push(winMat);

    for (const side of sides) {
      const along = side.id === 's' || side.id === 'n' ? 'x' : 'z';
      const doorOffset =
        doorSide === side.id
          ? along === 'x'
            ? clamp(place.door.x + 0.5 - cx, -side.half + 0.55, side.half - 0.55)
            : clamp(place.door.y + 0.5 - cz, -side.half + 0.55, side.half - 0.55)
          : null;

      if (doorOffset !== null) {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 1.22), trimMat);
        door.position.set(side.x + (along === 'x' ? doorOffset : 0), 0.71, side.z + (along === 'z' ? doorOffset : 0));
        door.position.x += side.rot === Math.PI / 2 ? 0.012 : side.rot === -Math.PI / 2 ? -0.012 : 0;
        door.position.z += side.rot === 0 ? 0.012 : side.rot === Math.PI ? -0.012 : 0;
        door.rotation.y = side.rot;
        g.add(door);

        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.06, 7, 6), winMat);
        lamp.position.set(door.position.x, 1.48, door.position.z);
        g.add(lamp);
      }

      // two windows per wall, tucked away from the door
      for (const frac of [-0.28, 0.28]) {
        const offset = side.half * frac;
        if (doorOffset !== null && Math.abs(offset - doorOffset) < 0.45) continue;
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.4), winMat);
        win.position.set(
          side.x + (along === 'x' ? offset : 0) + (side.rot === Math.PI / 2 ? 0.012 : side.rot === -Math.PI / 2 ? -0.012 : 0),
          height * 0.62,
          side.z + (along === 'z' ? offset : 0) + (side.rot === 0 ? 0.012 : side.rot === Math.PI ? -0.012 : 0),
        );
        win.rotation.y = side.rot;
        g.add(win);
      }
    }

    // chimney on the taller houses
    if (place.id === 'nest' || place.id === 'bakery') {
      const chimney = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.85, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x7a5f4b, roughness: 1 }),
      );
      chimney.position.set(hw * 0.45, height + 0.9, -hh * 0.35);
      chimney.castShadow = true;
      g.add(chimney);
    }

    scene.add(g);
  }

  function buildRuins(t) {
    const place = t.places.find((p) => p.id === 'ruins');
    if (!place) return;
    const stone = new THREE.MeshStandardMaterial({ color: 0x8b8479, roughness: 0.98 });
    const spots = [
      [4.4, 26.0, 1.2, 0.62],
      [8.8, 27.2, 0.8, 0.44],
      [6.2, 30.4, 1.5, 0.5],
      [9.4, 31.2, 0.6, 0.34],
      [3.8, 29.4, 0.9, 0.38],
    ];
    for (const [x, z, height, radius] of spots) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.88, radius, height, 8), stone);
      col.position.set(x, height / 2, z);
      col.rotation.z = (x % 1) * 0.06 - 0.03;
      col.castShadow = true;
      col.receiveShadow = true;
      scene.add(col);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, 0.1, 8), stone);
      cap.position.set(x, height + 0.05, z);
      scene.add(cap);
    }
  }

  function buildDuck(t) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.9 }),
    );
    body.scale.set(1.3, 0.75, 0.9);
    body.position.y = 0.1;
    g.add(body);
    const neck = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), new THREE.MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.85 }));
    neck.position.set(0, 0.26, 0.15);
    g.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.85 }));
    head.position.set(0, 0.37, 0.21);
    g.add(head);
    const bill = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.11, 5), new THREE.MeshStandardMaterial({ color: 0xd7a34a, roughness: 0.7 }));
    bill.rotation.x = Math.PI / 2;
    bill.position.set(0, 0.36, 0.3);
    g.add(bill);
    g.position.set(30.2, 0.06, 29.8);
    duck = g;
    duck.userData.phase = 0;
    scene.add(g);
    // keep the renderer from warning about an unused argument
    void t;
  }

  function buildRain() {
    rainCount = 1500;
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
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    rain.visible = false;
    rain.frustumCulled = false;
    scene.add(rain);
  }

  // ---------------------------------------------------------------- input

  const keys = Object.create(null);
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

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

  canvas.addEventListener('pointerdown', (e) => {
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
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    cam.yaw -= dx * 0.0046;
    cam.pitch = clamp(cam.pitch + dy * 0.0032, 0.1, 1.06);
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
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cam.want = clamp(cam.want + e.deltaY * 0.0017, 3.4, 12);
    },
    { passive: false },
  );

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
    const r = 0.29;
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

  function cameraBlocked(x, z) {
    const t = tileAt(x, z);
    return t === T.building || t === T.tree;
  }

  // ---------------------------------------------------------------- movement

  function updatePlayer(dt) {
    const forward = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const strafe = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const running = keys.ShiftLeft || keys.ShiftRight;
    let dx = -Math.sin(cam.yaw) * forward + Math.cos(cam.yaw) * strafe;
    let dz = -Math.cos(cam.yaw) * forward - Math.sin(cam.yaw) * strafe;
    const len = Math.hypot(dx, dz);
    if (len > 1) {
      dx /= len;
      dz /= len;
    }
    const speed = running ? 5.6 : 3.2;
    const k = 1 - Math.exp(-dt * 12);
    player.vx = damp(player.vx, dx * speed, k);
    player.vz = damp(player.vz, dz * speed, k);
    if (Math.abs(player.vx) < 0.01) player.vx = 0;
    if (Math.abs(player.vz) < 0.01) player.vz = 0;

    if (keys.Space && player.onGround) {
      player.vy = 5.2;
      player.onGround = false;
    }
    player.vy -= 15.5 * dt;
    player.y += player.vy * dt;
    if (player.y <= 0) {
      player.y = 0;
      player.vy = 0;
      player.onGround = true;
    }

    const nx = player.x + player.vx * dt;
    if (!blocked(nx, player.z)) player.x = nx;
    else player.vx = 0;
    const nz = player.z + player.vz * dt;
    if (!blocked(player.x, nz)) player.z = nz;
    else player.vz = 0;

    const speedNow = Math.hypot(player.vx, player.vz);
    if (speedNow > 0.35) player.targetYaw = Math.atan2(player.vx, player.vz);
    playerGroup.position.set(player.x, player.y, player.z);
    playerGroup.rotation.y = dampAngle(playerGroup.rotation.y, player.targetYaw, 1 - Math.exp(-dt * 11));

    player.phase += dt * (3 + speedNow * 2.6);
    const swing = speedNow > 0.25 ? Math.sin(player.phase) * Math.min(0.62, speedNow * 0.14) : 0;
    const { arms, legs, lantern, light } = playerGroup.userData;
    arms[0].rotation.x = swing;
    arms[1].rotation.x = -swing;
    legs[0].rotation.x = -swing;
    legs[1].rotation.x = swing;
    const bob = speedNow > 0.25 ? Math.abs(Math.sin(player.phase * 2)) * 0.02 : Math.sin(player.phase * 0.7) * 0.006;
    playerGroup.position.y = player.y + bob;
    lantern.rotation.z = Math.sin(player.phase * 1.4) * 0.05;
    light.intensity = 0.2 + (snap?.darkness ?? 0) * 0.85;
  }

  function updateCamera(dt) {
    if (keys.ArrowLeft) cam.yaw += dt * 1.8;
    if (keys.ArrowRight) cam.yaw -= dt * 1.8;
    if (keys.ArrowUp) cam.pitch = clamp(cam.pitch - dt * 0.9, 0.1, 1.06);
    if (keys.ArrowDown) cam.pitch = clamp(cam.pitch + dt * 0.9, 0.1, 1.06);

    cam.dist = damp(cam.dist, cam.want, 1 - Math.exp(-dt * 9));
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const target = new THREE.Vector3(player.x, player.y + 1.2, player.z);
    const offX = Math.sin(cam.yaw) * cam.dist * cp;
    const offZ = Math.cos(cam.yaw) * cam.dist * cp;
    const offY = cam.dist * sp + 0.18;

    let allowed = 1;
    for (let step = 0.16; step <= 1.001; step += 0.055) {
      if (cameraBlocked(target.x + offX * step, target.z + offZ * step)) {
        allowed = Math.max(0.18, step - 0.07);
        break;
      }
    }

    const px = target.x + offX * allowed;
    const py = Math.max(0.65, target.y + offY * allowed);
    const pz = target.z + offZ * allowed;
    const k = 1 - Math.exp(-dt * (cam.ready ? 13 : 100));
    camera.position.lerp(new THREE.Vector3(px, py, pz), k);
    cam.look.lerp(target, k);
    camera.lookAt(cam.look);
    cam.ready = true;
  }

  // ---------------------------------------------------------------- state

  const FACING = FACING_YAW;

  function applyState(s) {
    if (!s || !s.creature) return;
    snap = s;
    const c = s.creature;
    mochi.x = c.x;
    mochi.z = c.y;
    mochi.moving = !!c.moving;
    mochi.asleep = !!c.asleep;
    const nextYaw = FACING[c.facing];
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
        // EventSource retries on its own; poll once in the meantime so the owl
        // does not appear frozen if the stream is blocked by a proxy.
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
      scratchBottom.lerp(warm, golden * 0.5);
      scratchTop.lerp(warm, golden * 0.1);
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
      sun.intensity = (0.55 + elev * 2.05) * (LIGHT_BY_WEATHER[weather] ?? 1);
    } else {
      sun.position.copy(moonPos);
      sun.color.set('#a9c3e8');
      sun.intensity = 0.48 * (0.45 + dark * 0.55) * (LIGHT_BY_WEATHER[weather] ?? 1);
    }
    sun.target.position.set(18, 0, 18);
    sun.target.updateMatrixWorld();

    hemi.color.copy(scratchTop);
    hemi.groundColor.set('#3b3a2b');
    hemi.intensity = 0.32 + (1 - dark) * 0.72;
    ambient.intensity = 0.1 + (1 - dark) * 0.24;

    // sun and moon discs sit far away in the sky
    const sunDir = sunPos.clone().normalize().multiplyScalar(235);
    sunDisc.position.copy(sunDir);
    sunDisc.visible = isDay && weather === 'clear';
    const moonDir = moonPos.clone().normalize().multiplyScalar(235);
    moonDisc.position.copy(moonDir);
    moonDisc.visible = dark > 0.2 && weather !== 'fog';
    moonMat.opacity = clamp(dark * 1.2, 0, 1);
    moonGlow.material.opacity = 0.45 * dark;
    sunGlow.material.opacity = 0.6 * (1 - dark) * (weather === 'clear' ? 1 : 0.25);

    stars.material.opacity = dark * (weather === 'clear' ? 0.85 : weather === 'fog' ? 0.05 : 0.22);
    stars.position.set(0, 0, 0);

    // lit windows and lamps after dark
    const winGlow = 0.06 + dark * 1.35;
    for (const m of windowMats) m.emissiveIntensity = winGlow;
    for (const m of lampBulbs) m.emissiveIntensity = 0.5 + dark * 1.5;
    for (const g of lampGlows) g.opacity = dark * 0.85;
    mochiGroup.userData.light.intensity = dark * 0.8;

    for (const l of lampLights) l.intensity = 0;
    if (dark > 0.04 && lampPositions.length) {
      const nearest = lampPositions
        .map((p, i) => ({ i, d: (p.x - player.x) ** 2 + (p.z - player.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, lampLights.length);
      nearest.forEach((entry, index) => {
        const p = lampPositions[entry.i];
        const light = lampLights[index];
        light.position.set(p.x, 1.95, p.z);
        light.intensity = dark * 1.9;
      });
    }

    if (waterUniforms) waterUniforms.uTime.value = now / 1000;
    sky.position.set(camera.position.x, 0, camera.position.z);
    sunDisc.position.set(player.x + sunDir.x, sunDir.y, player.z + sunDir.z);
    moonDisc.position.set(player.x + moonDir.x, moonDir.y, player.z + moonDir.z);
  }

  // ---------------------------------------------------------------- animation

  function updateMochi(dt) {
    if (!mochi.placed) return;
    const k = 1 - Math.exp(-dt * 6.5);
    mochiGroup.position.x = damp(mochiGroup.position.x, mochi.x, k);
    mochiGroup.position.z = damp(mochiGroup.position.z, mochi.z, k);
    mochi.phase += dt * (mochi.moving ? 7.5 : 1.7);
    mochiGroup.position.y =
      (mochi.moving ? Math.abs(Math.sin(mochi.phase)) * 0.07 : Math.sin(mochi.phase) * 0.012) +
      (mochi.asleep ? -0.02 : 0);
    mochiGroup.rotation.y = dampAngle(mochiGroup.rotation.y, mochi.yaw, 1 - Math.exp(-dt * 7));

    const wingL = mochiGroup.userData.wingL;
    const wingR = mochiGroup.userData.wingR;
    if (mochi.moving) {
      const flap = Math.sin(mochi.phase * 1.5) * 0.22;
      wingL.rotation.z = 0.22 + flap;
      wingR.rotation.z = -0.22 - flap;
    } else {
      wingL.rotation.z = damp(wingL.rotation.z, 0.05, 1 - Math.exp(-dt * 3));
      wingR.rotation.z = damp(wingR.rotation.z, -0.05, 1 - Math.exp(-dt * 3));
    }

    const label = mochiGroup.userData.label;
    if (label) {
      label.visible = true;
      label.material.opacity = clamp(1.5 - Math.hypot(mochi.x - player.x, mochi.z - player.z) / 26, 0.3, 1);
    }
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
    duck.position.set(30.4 + Math.cos(angle) * 1.15, 0.055 + Math.sin(t * 1.3) * 0.012, 29.8 + Math.sin(angle) * 0.95);
    duck.rotation.y = -angle + Math.PI / 2;
    duck.rotation.z = Math.sin(t * 1.1) * 0.03;
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
    const sx = dx * Math.cos(cam.yaw) - dz * Math.sin(cam.yaw);
    const sy = -dx * Math.sin(cam.yaw) - dz * Math.cos(cam.yaw);
    const deg = (Math.atan2(sx, sy) * 180) / Math.PI;
    $('arrow').style.transform = `rotate(${deg.toFixed(1)}deg)`;

    if (dist < 2.6 && !foundOnce) {
      foundOnce = true;
      showToast(mochi.asleep ? 'He is asleep, feathers fluffed.' : 'You found Mochi.');
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
          : 'standing about';
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

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;

    if (town) {
      updatePlayer(dt);
      updateCamera(dt);
      updateAtmosphere(now);
      updateMochi(dt);
      updateOfferings(now);
      updateDuck(now);
      updateRain(dt);
      updateHud(now);
    } else {
      updateCamera(dt);
    }

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(frame);
  updateCamera(0.016);
})();
