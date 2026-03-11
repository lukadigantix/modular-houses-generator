'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// Constants — 1 cell = 2.4 m in real life
// ---------------------------------------------------------------------------
const CELL     = 120;  // px (logical, before zoom)
const COLS     = 16;
const ROWS     = 10;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ModuleType = 'small' | 'large';

interface PlacedModule {
  id:      string;
  type:    ModuleType;
  col:     number;
  row:     number;
  /** 0=eave-left 1=eave-top 2=eave-right 3=eave-bottom (all large only) */
  rotation: 0 | 1 | 2 | 3;
}

interface DragState {
  id:        string;
  /** Click offset (px) from the module's top-left corner inside the grid */
  offsetX:   number;
  offsetY:   number;
  /** Current snapped ghost position */
  ghostCol:  number;
  ghostRow:  number;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------
function moduleSize(m: PlacedModule): { w: number; h: number } {
  if (m.type === 'small') return { w: 1, h: 1 };
  return m.rotation % 2 !== 0 ? { w: 1, h: 2 } : { w: 2, h: 1 };
}

function overlaps(a: PlacedModule, b: PlacedModule): boolean {
  const as = moduleSize(a);
  const bs = moduleSize(b);
  return (
    a.col < b.col + bs.w &&
    a.col + as.w > b.col &&
    a.row < b.row + bs.h &&
    a.row + as.h > b.row
  );
}

function inBounds(m: PlacedModule): boolean {
  const { w, h } = moduleSize(m);
  return m.col >= 0 && m.row >= 0 && m.col + w <= COLS && m.row + h <= ROWS;
}

function firstFreePosition(
  type:     ModuleType,
  rotation: 0 | 1 | 2 | 3,
  placed:   PlacedModule[],
): { col: number; row: number } | null {
  const dummy = { id: '__test__', type, col: 0, row: 0, rotation } as PlacedModule;
  // Step by 0.5 so auto-placement also respects the half-cell grid
  for (let row = 0; row < ROWS; row += 0.5) {
    for (let col = 0; col < COLS; col += 0.5) {
      const candidate = { ...dummy, col, row };
      if (inBounds(candidate) && !placed.some(m => overlaps(candidate, m))) {
        return { col, row };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generator — ridge-joint layout
//
// Vocabulary extracted from architectural reference layouts:
//
//   MALI  = "ridge joint": a 1×1 hub where one or more VELIKI roofs terminate.
//
//   Three arm types radiate FROM a joint (col, row):
//     LEFT  arm → HH at (col-2, row,   rot=0)  eave-left,   ridge points →right→ joint
//     RIGHT arm → HH at (col+1, row,   rot=2)  eave-right,  ridge points →left → joint
//     BELOW arm → VV at (col,   row+1, rot=3)  eave-bottom, ridge points →up  → joint
//
//   Joint spacing rules (to avoid arm collisions):
//     Horizontal chain :  next joint at col ± 3  (leaves 2 cells for HH arm)
//     Vertical stack   :  next joint at row ± 1  (joints share the same column)
// ---------------------------------------------------------------------------
function generateLayout(smallCount: number, largeCount: number): PlacedModule[] {
  const result: PlacedModule[] = [];

  const shuffle = <T,>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Check whether a rectangle (col, row, w, h) is on the grid and overlaps nothing in result
  const free = (col: number, row: number, w: number, h: number): boolean => {
    if (col < 0 || row < 0 || col + w > COLS || row + h > ROWS) return false;
    return !result.some(m => {
      const { w: mw, h: mh } = moduleSize(m);
      return col < m.col + mw && col + w > m.col && row < m.row + mh && row + h > m.row;
    });
  };

  // ── PHASE 1: place MALI (ridge joints) ────────────────────────────────────
  const joints: { col: number; row: number }[] = [];

  const tryJoint = (col: number, row: number): boolean => {
    if (!free(col, row, 1, 1)) return false;
    joints.push({ col, row });
    result.push({ id: crypto.randomUUID(), type: 'small', col, row, rotation: 0 });
    return true;
  };

  // Seed in the upper portion of the grid so layout is immediately visible
  const seedCol = 3 + Math.floor(Math.random() * (COLS - 6));
  const seedRow = 1 + Math.floor(Math.random() * 2);
  if (!tryJoint(seedCol, seedRow)) tryJoint(4, 1);

  for (let i = 1; i < smallCount; i++) {
    // Candidate positions relative to existing joints:
    //   col ± 3  → horizontal chain (fits a 2-cell HH arm between joints)
    //   row ± 1  → vertical stack   (joints share column, each with own arms)
    const candidates = shuffle(
      joints.flatMap(j => [
        { col: j.col + 3, row: j.row     },
        { col: j.col - 3, row: j.row     },
        { col: j.col,     row: j.row + 1 },
        { col: j.col,     row: j.row - 1 },
        { col: j.col + 3, row: j.row + 1 },
        { col: j.col + 3, row: j.row - 1 },
        { col: j.col - 3, row: j.row + 1 },
        { col: j.col - 3, row: j.row - 1 },
      ]),
    );

    let placed = false;
    for (const c of candidates) {
      if (tryJoint(c.col, c.row)) { placed = true; break; }
    }
    if (!placed) {
      // Fallback: any free cell
      outer: for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS; row++) {
          if (tryJoint(col, row)) { placed = true; break outer; }
        }
      }
    }
  }

  // ── PHASE 2: place VELIKI as ridge arms ────────────────────────────────────
  type ArmDef = { col: number; row: number; w: number; h: number; rot: 0 | 2 | 3 };

  const armsOf = (col: number, row: number): ArmDef[] => [
    { col: col - 2, row,       w: 2, h: 1, rot: 0 }, // LEFT  arm
    { col: col + 1, row,       w: 2, h: 1, rot: 2 }, // RIGHT arm
    { col,          row: row + 1, w: 1, h: 2, rot: 3 }, // BELOW arm
  ];

  let largeLeft = largeCount;

  // Pass 1 — give every joint at least one arm (random arm selection per joint)
  for (const j of shuffle([...joints])) {
    if (largeLeft <= 0) break;
    const avail = shuffle(armsOf(j.col, j.row)).filter(a => free(a.col, a.row, a.w, a.h));
    if (!avail.length) continue;
    const a = avail[0];
    result.push({ id: crypto.randomUUID(), type: 'large', col: a.col, row: a.row, rotation: a.rot });
    largeLeft--;
  }

  // Pass 2 — fill remaining large count across all joints
  let progress = true;
  while (largeLeft > 0 && progress) {
    progress = false;
    for (const j of shuffle([...joints])) {
      if (largeLeft <= 0) break;
      const avail = shuffle(armsOf(j.col, j.row)).filter(a => free(a.col, a.row, a.w, a.h));
      if (!avail.length) continue;
      const a = avail[0];
      result.push({ id: crypto.randomUUID(), type: 'large', col: a.col, row: a.row, rotation: a.rot });
      largeLeft--;
      progress = true;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scene3D helpers
// ---------------------------------------------------------------------------
const ROOF_RISE = 1.0; // lean-to roof rise in meters

// ---------------------------------------------------------------------------
// Scene3D — Three.js 3D preview
// ---------------------------------------------------------------------------
function Scene3D({ modules }: { modules: PlacedModule[] }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current!;
    // Read dimensions after mount; fall back to window size if the element
    // hasn't been laid-out yet (clientWidth/Height === 0).
    const w = mount.clientWidth  || window.innerWidth;
    const h = mount.clientHeight || (window.innerHeight - 56);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x1b3458);
    mount.appendChild(renderer.domElement);

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1b3458);
    scene.fog = new THREE.FogExp2(0x1b3458, 0.006);

    // Compute center from placed modules (or fall back to grid centre)
    let centerX: number, centerZ: number;
    if (modules.length === 0) {
      centerX = (COLS / 2) * 2.4;
      centerZ = (ROWS / 2) * 2.4;
    } else {
      let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
      for (const m of modules) {
        const { w: mw2, h: mh2 } = moduleSize(m);
        if (m.col < minC) minC = m.col;
        if (m.row < minR) minR = m.row;
        if (m.col + mw2 > maxC) maxC = m.col + mw2;
        if (m.row + mh2 > maxR) maxR = m.row + mh2;
      }
      centerX = (minC + maxC) / 2 * 2.4;
      centerZ = (minR + maxR) / 2 * 2.4;
    }

    // Camera
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
    camera.position.set(centerX, 22, centerZ + 28);
    camera.lookAt(centerX, 0, centerZ);

    // Lights
    const hemi = new THREE.HemisphereLight(0x3464a0, 0x1a1a28, 0.7);
    scene.add(hemi);

    const dirLight = new THREE.DirectionalLight(0xfff5e8, 2.0);
    dirLight.position.set(centerX + 20, 35, centerZ - 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width  = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near   = 0.5;
    dirLight.shadow.camera.far    = 200;
    dirLight.shadow.camera.left   = -60;
    dirLight.shadow.camera.right  =  60;
    dirLight.shadow.camera.top    =  60;
    dirLight.shadow.camera.bottom = -60;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0x6a90c0, 0.9);
    fillLight.position.set(centerX - 20, 18, centerZ + 20);
    scene.add(fillLight);

    // Floor
    const floorGeo = new THREE.PlaneGeometry(COLS * 2.4 + 60, ROWS * 2.4 + 60);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x232330, roughness: 0.88, metalness: 0.05 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centerX, 0, centerZ);
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid lines
    const gridHelper = new THREE.GridHelper(
      Math.max(COLS, ROWS) * 2.4 + 10,
      Math.max(COLS, ROWS) + 4,
      0x2d2d3c,
      0x272732,
    );
    gridHelper.position.set(centerX, 0.01, centerZ);
    scene.add(gridHelper);

    // Modules — rendered as structural construction frames
    const BEAM  = 0.12; // cross-section of each structural member (meters)
    const INSET = 0.08; // gap from cell boundary so adjacent frames never share a plane

    modules.forEach(m => {
      const { w: mw, h: mh } = moduleSize(m);
      const worldW = mw * 2.4;
      const worldD = mh * 2.4;
      const worldH = 2.4;
      const ox = m.col * 2.4;
      const oz = m.row * 2.4;

      const color = m.type === 'small' ? 0x717180 : 0xf2f2f2;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: m.type === 'small' ? 0.5 : 0.15, metalness: m.type === 'small' ? 0.4 : 0.1 });

      // Helper: world-space Vector3 relative to module origin
      const V = (x: number, y: number, z: number) => new THREE.Vector3(ox + x, y, oz + z);

      // Helper: add a structural beam between two world-space points
      const addMember = (pA: THREE.Vector3, pB: THREE.Vector3, material: THREE.Material = mat) => {
        const dir = new THREE.Vector3().subVectors(pB, pA);
        const len = dir.length();
        if (len < 0.001) return;
        const mid = new THREE.Vector3().addVectors(pA, pB).multiplyScalar(0.5);
        const geo = new THREE.BoxGeometry(BEAM, len, BEAM);
        const mesh = new THREE.Mesh(geo, material);
        mesh.position.copy(mid);
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        scene.add(mesh);
      };

      // 8 corner vertices — inset from cell boundary so touching modules never share a plane
      const x0 = INSET,         x1 = worldW - INSET;
      const z0 = INSET,         z1 = worldD - INSET;
      const b00 = V(x0, 0,      z0);  // floor front-left
      const b10 = V(x1, 0,      z0);  // floor front-right
      const b01 = V(x0, 0,      z1);  // floor back-left
      const b11 = V(x1, 0,      z1);  // floor back-right
      const t00 = V(x0, worldH, z0);  // top front-left
      const t10 = V(x1, worldH, z0);  // top front-right
      const t01 = V(x0, worldH, z1);  // top back-left
      const t11 = V(x1, worldH, z1);  // top back-right

      // 4 vertical corner posts
      addMember(b00, t00);
      addMember(b10, t10);
      addMember(b01, t01);
      addMember(b11, t11);

      // Top perimeter beams
      addMember(t00, t10);
      addMember(t01, t11);
      addMember(t00, t01);
      addMember(t10, t11);

      // Floor perimeter beams
      addMember(b00, b10);
      addMember(b01, b11);
      addMember(b00, b01);
      addMember(b10, b11);

      // Translucent glass fill panels
      const panelMat2 = new THREE.MeshStandardMaterial({
        color: m.type === 'small' ? 0x606070 : 0xecf0f4,
        roughness: m.type === 'small' ? 0.55 : 0.08,
        metalness: 0.0,
        transparent: true,
        opacity: m.type === 'small' ? 0.80 : 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const addQuad = (va: THREE.Vector3, vb: THREE.Vector3, vc: THREE.Vector3, vd: THREE.Vector3, pm: THREE.Material = panelMat2) => {
        const qgeo = new THREE.BufferGeometry();
        const verts = new Float32Array([
          va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z,
          va.x, va.y, va.z, vc.x, vc.y, vc.z, vd.x, vd.y, vd.z,
        ]);
        qgeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        qgeo.computeVertexNormals();
        const qmesh = new THREE.Mesh(qgeo, pm);
        qmesh.receiveShadow = true;
        scene.add(qmesh);
      };
      // 4 walls
      addQuad(b00, b10, t10, t00);
      addQuad(b01, b11, t11, t01);
      addQuad(b00, b01, t01, t00);
      addQuad(b10, b11, t11, t10);
      // Ceiling panel
      addQuad(t00, t10, t11, t01);

      if (m.type === 'small') return;

      // Shed roof frame — lean-to skeleton
      // 0=eave-left  pitchInZ=false flipped=false
      // 1=eave-top   pitchInZ=true  flipped=false
      // 2=eave-right pitchInZ=false flipped=true
      // 3=eave-bot   pitchInZ=true  flipped=true
      const pitchInZ = m.rotation === 1 || m.rotation === 3;
      const flipped  = m.rotation === 2 || m.rotation === 3;
      const roofMat  = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.2, metalness: 0.15 });

      let eave0: THREE.Vector3, eave1: THREE.Vector3;
      let ridge0: THREE.Vector3, ridge1: THREE.Vector3;

      if (!pitchInZ) {
        // Slope runs along X; eave and ridge are parallel to Z
        const eX = flipped ? x1 : x0;
        const rX = flipped ? x0 : x1;
        eave0  = V(eX, worldH,             z0);
        eave1  = V(eX, worldH,             z1);
        ridge0 = V(rX, worldH + ROOF_RISE, z0);
        ridge1 = V(rX, worldH + ROOF_RISE, z1);
      } else {
        // Slope runs along Z; eave and ridge are parallel to X
        const eZ = flipped ? z1 : z0;
        const rZ = flipped ? z0 : z1;
        eave0  = V(x0, worldH,             eZ);
        eave1  = V(x1, worldH,             eZ);
        ridge0 = V(x0, worldH + ROOF_RISE, rZ);
        ridge1 = V(x1, worldH + ROOF_RISE, rZ);
      }

      // Eave beam & ridge beam
      addMember(eave0,  eave1,  roofMat);
      addMember(ridge0, ridge1, roofMat);

      // End rafters (gable edges)
      addMember(eave0,  ridge0, roofMat);
      addMember(eave1,  ridge1, roofMat);

      // Mid rafter
      const eaveMid  = eave0.clone().lerp(eave1,   0.5);
      const ridgeMid = ridge0.clone().lerp(ridge1,  0.5);
      addMember(eaveMid, ridgeMid, roofMat);

      // Mid-slope purlin (runs parallel to eave/ridge at half-slope height)
      const midY = worldH + ROOF_RISE / 2;
      if (!pitchInZ) {
        addMember(V((x0 + x1) / 2, midY, z0), V((x0 + x1) / 2, midY, z1), roofMat);
      } else {
        addMember(V(x0, midY, (z0 + z1) / 2), V(x1, midY, (z0 + z1) / 2), roofMat);
      }

      // Roof fill panel
      const roofPanelMat = new THREE.MeshStandardMaterial({
        color: 0xd0d8e0,
        roughness: 0.12,
        metalness: 0.2,
        transparent: true,
        opacity: 0.70,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      addQuad(eave0, eave1, ridge1, ridge0, roofPanelMat);
    });

    // OrbitControls — target the layout centre
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.06;
    controls.target.set(centerX, 0, centerZ);
    controls.minDistance    = 4;
    controls.maxDistance    = 200;
    controls.maxPolarAngle  = Math.PI / 2 - 0.02;
    controls.update();

    // Render loop
    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Responsive resize
    const observer = new ResizeObserver(() => {
      const rw = mount.clientWidth;
      const rh = mount.clientHeight;
      camera.aspect = rw / rh;
      camera.updateProjectionMatrix();
      renderer.setSize(rw, rh);
    });
    observer.observe(mount);

    return () => {
      cancelAnimationFrame(animId);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
  // Only re-init when the placed modules change
  }, [modules]);

  return <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function Home() {
  const [modules, setModules] = useState<PlacedModule[]>([]);
  const [drag,    setDrag]    = useState<DragState | null>(null);
  const [zoom,    setZoom]    = useState(1);
  const [view,    setView]    = useState<'2d' | '3d'>('2d');
  const [genSmall, setGenSmall] = useState(2);
  const [genLarge, setGenLarge] = useState(4);
  const gridRef   = useRef<HTMLDivElement>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const needsCenterRef = useRef(false);
  // Mutable ref so drag event handlers always see the latest zoom without stale closures
  const zoomRef   = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const changeZoom = (delta: number) =>
    setZoom(prev => parseFloat(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + delta)).toFixed(2)));

  // ---- Add module ----
  const addModule = (type: ModuleType) => {
    const pos = firstFreePosition(type, 0, modules);
    if (!pos) return; // grid full
    setModules(prev => [
      ...prev,
      { id: crypto.randomUUID(), type, col: pos.col, row: pos.row, rotation: 0 },
    ]);
  };

  // ---- Remove module ----
  const removeModule = (id: string) => {
    setModules(prev => prev.filter(m => m.id !== id));
  };

  // ---- Rotate large module ----
  const rotateModule = (id: string) => {
    setModules(prev =>
      prev.map(m => {
        if (m.id !== id || m.type === 'small') return m;
        const rotation = ((m.rotation + 1) % 4) as 0 | 1 | 2 | 3;
        const newSize  = rotation % 2 !== 0 ? { w: 1, h: 2 } : { w: 2, h: 1 };
        const col      = Math.min(m.col, COLS - newSize.w);
        const row      = Math.min(m.row, ROWS - newSize.h);
        const updated  = { ...m, rotation, col, row };
        const others   = prev.filter(o => o.id !== id);
        if (others.some(o => overlaps(updated, o))) return m;
        return updated;
      }),
    );
  };

  // ---- Generate layout ----
  const handleGenerate = () => {
    if (genSmall === 0 && genLarge === 0) return;
    needsCenterRef.current = true;
    setModules(generateLayout(genSmall, genLarge));
  };

  // ---- Export PDF ----
  const handleExportPDF = () => {
    if (modules.length === 0) return;
    let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
    for (const m of modules) {
      const { w, h } = moduleSize(m);
      if (m.col < minC) minC = m.col;
      if (m.row < minR) minR = m.row;
      if (m.col + w > maxC) maxC = m.col + w;
      if (m.row + h > maxR) maxR = m.row + h;
    }
    const SCALE = 84;
    const PAD = 40;
    const svgW = (maxC - minC) * SCALE + PAD * 2;
    const svgH = (maxR - minR) * SCALE + PAD * 2;
    // grid lines behind modules
    const gridLines: string[] = [];
    for (let c = 0; c <= maxC - minC; c++) {
      const x = c * SCALE + PAD;
      gridLines.push(`<line x1="${x}" y1="${PAD}" x2="${x}" y2="${svgH - PAD}" stroke="#e8eaed" stroke-width="0.5"/>`);
    }
    for (let r = 0; r <= maxR - minR; r++) {
      const y = r * SCALE + PAD;
      gridLines.push(`<line x1="${PAD}" y1="${y}" x2="${svgW - PAD}" y2="${y}" stroke="#e8eaed" stroke-width="0.5"/>`);
    }
    const rects = modules.map((m, idx) => {
      const { w, h } = moduleSize(m);
      const x = (m.col - minC) * SCALE + PAD;
      const y = (m.row - minR) * SCALE + PAD;
      const isSmall = m.type === 'small';
      const fill    = isSmall ? '#3d3d4a' : '#ffffff';
      const stroke  = isSmall ? '#2a2a36' : '#c8ccd4';
      const tc      = isSmall ? '#ffffff' : '#1a1a2e';
      const tc2     = isSmall ? 'rgba(255,255,255,0.55)' : '#9098a8';
      const label   = isSmall ? 'MALI' : 'VELIKI';
      const size    = isSmall ? '2.4 × 2.4 m' : (w === 2 ? '4.8 × 2.4 m' : '2.4 × 4.8 m');
      const numX    = x + w * SCALE - 10;
      const numY    = y + 14;
      const cx      = x + w * SCALE / 2;
      const cy      = y + h * SCALE / 2;
      const shadow  = isSmall ? '' : `<rect x="${x+4}" y="${y+4}" width="${w*SCALE-8}" height="${h*SCALE-8}" rx="7" fill="#e4e7ec" opacity="0.6"/>`;
      return [
        shadow,
        `<rect x="${x+2}" y="${y+2}" width="${w*SCALE-4}" height="${h*SCALE-4}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
        `<text x="${numX}" y="${numY}" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" font-weight="500" fill="${tc2}" text-anchor="end">${idx + 1}</text>`,
        `<text x="${cx}" y="${cy - 6}" font-family="'Inter','Helvetica Neue',sans-serif" font-size="10" font-weight="700" fill="${tc}" text-anchor="middle" letter-spacing="0.06em">${label}</text>`,
        `<text x="${cx}" y="${cy + 10}" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="${tc2}" text-anchor="middle">${size}</text>`,
      ].join('');
    }).join('');
    // legend
    const legend = `<g transform="translate(${PAD},${svgH - 18})">
      <rect x="0" y="-7" width="10" height="10" rx="2" fill="#3d3d4a"/>
      <text x="14" y="1" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="#9098a8">Mali (2.4 × 2.4 m)</text>
      <rect x="130" y="-7" width="10" height="10" rx="2" fill="#ffffff" stroke="#c8ccd4" stroke-width="1"/>
      <text x="144" y="1" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="#9098a8">Veliki (4.8 × 2.4 m / 2.4 × 4.8 m)</text>
    </g>`;
    const bboxW = bbox ? bbox.w.toFixed(1) : '—';
    const bboxH = bbox ? bbox.h.toFixed(1) : '—';
    const date  = new Date().toLocaleDateString('sr-Latn-RS', { year: 'numeric', month: 'long', day: 'numeric' });
    const refNo = `MH-${new Date().getFullYear()}-${String(modules.length).padStart(3,'0')}`;
    const totalAreaVal = totalArea.toFixed(2);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Modular Houses – Layout</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@page{margin:0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter','Helvetica Neue',Arial,sans-serif;background:#f2f4f7;color:#1a1a2e;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{background:#fff;max-width:860px;margin:0 auto;min-height:100vh}
/* ── HEADER BAND ── */
.header-band{background:#0f1724;padding:28px 52px;display:flex;align-items:center;justify-content:space-between}
.header-band img{height:34px;filter:brightness(0) invert(1)}
.header-right{text-align:right}
.header-ref{font-size:9px;letter-spacing:.12em;color:#4a6080;text-transform:uppercase;font-weight:600;margin-bottom:4px}
.header-date{font-size:13px;color:#c8d8e8;font-weight:500}
.header-email{font-size:11px;color:#4a6080;margin-top:3px}
/* ── BODY ── */
.body{padding:44px 52px 52px}
/* ── TITLE ROW ── */
.title-row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #f0f2f5}
.doc-title{font-size:22px;font-weight:700;color:#0f1724;letter-spacing:-.02em}
.doc-sub{font-size:12px;color:#9098a8;font-weight:500;margin-top:4px}
.badge{background:#f0f4ff;color:#3d5afe;font-size:10px;font-weight:700;letter-spacing:.06em;padding:5px 10px;border-radius:6px;border:1px solid #c8d4fc}
/* ── STATS ── */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:36px}
.stat{background:#f8f9fb;border:1px solid #eaecf0;border-radius:10px;padding:16px 14px;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:#0f1724;border-radius:10px 10px 0 0}
.stat-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#9098a8;font-weight:600;margin-bottom:8px}
.stat-value{font-size:18px;font-weight:700;color:#0f1724;line-height:1}
.stat-unit{font-size:11px;font-weight:500;color:#9098a8;margin-left:2px}
/* ── LAYOUT BOX ── */
.section-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#9098a8;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.section-label::after{content:'';flex:1;height:1px;background:#eaecf0}
.layout-box{background:#f8f9fb;border:1px solid #eaecf0;border-radius:12px;padding:32px;margin-bottom:36px;display:flex;justify-content:center;align-items:center;overflow:auto}
/* ── FOOTER ── */
.footer{margin-top:52px;padding-top:20px;border-top:1px solid #eaecf0;display:flex;justify-content:space-between;align-items:center}
.footer-left{font-size:10px;color:#c0c8d4}
.footer-right{font-size:10px;color:#c0c8d4;text-align:right}
@media print{body{background:#fff}.page{max-width:none}}
</style>
</head><body><div class="page">
<div class="header-band">
  <img src="${window.location.origin}/modular-dark.png" onerror="this.style.display='none'">
  <div class="header-right">
    <div class="header-ref">Ref. ${refNo}</div>
    <div class="header-date">${date}</div>
    <div class="header-email">info@modularhouses.rs</div>
  </div>
</div>
<div class="body">
  <div class="title-row">
    <div>
      <div class="doc-title">Specifikacija rasporeda modula</div>
      <div class="doc-sub">Modular Houses — generisani layout</div>
    </div>
    <div class="badge">NACRT / DRAFT</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-label">Ukupno modula</div><div class="stat-value">${modules.length}<span class="stat-unit">kom</span></div></div>
    <div class="stat"><div class="stat-label">Mali moduli</div><div class="stat-value">${smallCount}<span class="stat-unit">mod.</span></div></div>
    <div class="stat"><div class="stat-label">Veliki moduli</div><div class="stat-value">${largeCount}<span class="stat-unit">mod.</span></div></div>
    <div class="stat"><div class="stat-label">Gabarit</div><div class="stat-value" style="font-size:14px">${bboxW}<span class="stat-unit">×</span>${bboxH}<span class="stat-unit">m</span></div></div>
    <div class="stat"><div class="stat-label">Ukupna površina</div><div class="stat-value" style="font-size:16px">${totalAreaVal}<span class="stat-unit">m²</span></div></div>
  </div>
  <div class="section-label">Raspored modula</div>
  <div class="layout-box">
    <svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
      ${gridLines.join('')}${rects}${legend}
    </svg>
  </div>
  <div class="footer">
    <div class="footer-left">Modular Houses d.o.o. · info@modularhouses.rs</div>
    <div class="footer-right">Dokument generisan automatski — nije zamena za tehnički projekat.</div>
  </div>
</div>
</div><script>window.onload=()=>{window.print()}<\/script></body></html>`;
    const win = window.open('', '_blank');
    if (win) { win.document.write(html); win.document.close(); }
  };

  // ---- Scroll 2D to center the generated layout ----
  useEffect(() => {
    if (!needsCenterRef.current || modules.length === 0 || !scrollRef.current) return;
    needsCenterRef.current = false;
    let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
    for (const m of modules) {
      const { w, h } = moduleSize(m);
      if (m.col < minC) minC = m.col;
      if (m.row < minR) minR = m.row;
      if (m.col + w > maxC) maxC = m.col + w;
      if (m.row + h > maxR) maxR = m.row + h;
    }
    const PADDING = 32;
    const cx = PADDING + (minC + maxC) / 2 * CELL * zoom;
    const cy = PADDING + (minR + maxR) / 2 * CELL * zoom;
    const el = scrollRef.current;
    el.scrollTo({ left: cx - el.clientWidth / 2, top: cy - el.clientHeight / 2, behavior: 'smooth' });
  }, [modules, zoom]);

  // ---- Drag start ----
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.preventDefault();
      const m = modules.find(m => m.id === id);
      if (!m || !gridRef.current) return;
      const rect    = gridRef.current.getBoundingClientRect();
      const z       = zoomRef.current;
      // Divide screen-pixel offset by zoom to get logical-pixel offset
      const offsetX = (e.clientX - rect.left) / z - m.col * CELL;
      const offsetY = (e.clientY - rect.top)  / z - m.row * CELL;
      setDrag({ id, offsetX, offsetY, ghostCol: m.col, ghostRow: m.row });
    },
    [modules],
  );

  // ---- Drag move + drop ----
  useEffect(() => {
    if (!drag) return;

    const onMove = (e: MouseEvent) => {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const z    = zoomRef.current;
      // Convert screen pixels → logical pixels → cell units, snap to 0.5
      const rawX = (e.clientX - rect.left) / z - drag.offsetX;
      const rawY = (e.clientY - rect.top)  / z - drag.offsetY;
      const snap = (v: number) => Math.round(v / CELL * 2) / 2;
      setDrag(d =>
        d ? { ...d, ghostCol: snap(rawX), ghostRow: snap(rawY) } : null,
      );
    };

    const onUp = () => {
      if (!drag) return;
      const m = modules.find(m => m.id === drag.id);
      if (m) {
        const candidate = { ...m, col: drag.ghostCol, row: drag.ghostRow };
        const others    = modules.filter(o => o.id !== drag.id);
        const valid     = inBounds(candidate) && !others.some(o => overlaps(candidate, o));
        if (valid) {
          setModules(prev =>
            prev.map(mod => (mod.id === drag.id ? { ...mod, col: drag.ghostCol, row: drag.ghostRow } : mod)),
          );
        }
      }
      setDrag(null);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, [drag, modules]);

  // ---- Ghost validity ----
  const draggingModule = drag ? modules.find(m => m.id === drag.id) : null;
  const ghostValid = draggingModule
    ? (() => {
        const candidate = { ...draggingModule, col: drag!.ghostCol, row: drag!.ghostRow };
        const others    = modules.filter(o => o.id !== drag!.id);
        return inBounds(candidate) && !others.some(o => overlaps(candidate, o));
      })()
    : false;

  const smallCount = modules.filter(m => m.type === 'small').length;
  const largeCount = modules.filter(m => m.type === 'large').length;

  // ---- Bounding box + area ----
  const bbox = modules.length === 0 ? null : (() => {
    let minC = Infinity, minR = Infinity, maxC = -Infinity, maxR = -Infinity;
    for (const m of modules) {
      const { w, h } = moduleSize(m);
      if (m.col < minC)     minC = m.col;
      if (m.row < minR)     minR = m.row;
      if (m.col + w > maxC) maxC = m.col + w;
      if (m.row + h > maxR) maxR = m.row + h;
    }
    return { w: (maxC - minC) * 2.4, h: (maxR - minR) * 2.4 };
  })();
  const totalArea = modules.reduce((sum, m) => {
    const { w, h } = moduleSize(m);
    return sum + w * h * 5.76;
  }, 0);

  // ---- Wheel zoom (Ctrl/Cmd + scroll or pinch trackpad) ----
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(prev =>
      parseFloat(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev - e.deltaY * 0.002)).toFixed(2)),
    );
  }, []);

  // ---- Render ----
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: '#0f0f12', color: '#ffffff', userSelect: 'none' }}
    >
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <header style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: '#0d0d10',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        height: 56,
        flexShrink: 0,
        position: 'relative',
        fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
      }}>
        {/* ── Left: Logo + Add buttons ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginRight: 6 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/modular-logo.svg" alt="Modular" style={{ height: 28, width: 'auto', flexShrink: 0 }} />
          </div>

          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.07)', flexShrink: 0, margin: '0 4px' }} />

          {/* Add small */}
          <button
            onClick={() => addModule('small')}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 8, padding: '6px 13px',
              color: 'rgba(255,255,255,0.65)', cursor: 'pointer',
              fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
              transition: 'all 0.12s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.1)';
              (e.currentTarget as HTMLButtonElement).style.color = '#fff';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.65)';
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(255,255,255,0.4)', marginBottom: 1 }}>+</span>
            <span>Mali</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)', fontWeight: 400 }}>2.4m</span>
          </button>

          {/* Add large */}
          <button
            onClick={() => addModule('large')}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 8, padding: '6px 13px',
              color: 'rgba(255,255,255,0.65)', cursor: 'pointer',
              fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
              transition: 'all 0.12s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.1)';
              (e.currentTarget as HTMLButtonElement).style.color = '#fff';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.65)';
            }}
          >
            <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(255,255,255,0.4)', marginBottom: 1 }}>+</span>
            <span>Veliki</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)', fontWeight: 400 }}>4.8m</span>
          </button>
        </div>

        {/* ── Center: Generator (absolutely centered) ── */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {/* Mali stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#71717a', whiteSpace: 'nowrap' }}>Mali</span>
            <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden' }}>
              <button
                onClick={() => setGenSmall(s => Math.max(0, s - 1))}
                style={{ width: 32, height: 32, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.1s, color 0.1s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)'; }}
              >−</button>
              <span style={{ width: 36, textAlign: 'center', fontSize: 15, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontVariantNumeric: 'tabular-nums', userSelect: 'none' }}>{genSmall}</span>
              <button
                onClick={() => setGenSmall(s => Math.min(40, s + 1))}
                style={{ width: 32, height: 32, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.1s, color 0.1s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)'; }}
              >+</button>
            </div>
          </div>

          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

          {/* Veliki stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>Veliki</span>
            <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden' }}>
              <button
                onClick={() => setGenLarge(s => Math.max(0, s - 1))}
                style={{ width: 32, height: 32, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.1s, color 0.1s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)'; }}
              >−</button>
              <span style={{ width: 36, textAlign: 'center', fontSize: 15, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontVariantNumeric: 'tabular-nums', userSelect: 'none' }}>{genLarge}</span>
              <button
                onClick={() => setGenLarge(s => Math.min(20, s + 1))}
                style={{ width: 32, height: 32, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.1s, color 0.1s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)'; }}
              >+</button>
            </div>
          </div>

          {/* Generiši button */}
          <button
            onClick={handleGenerate}
            disabled={genSmall === 0 && genLarge === 0}
            style={{
              background: genSmall === 0 && genLarge === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.13)',
              borderRadius: 8, padding: '0 16px', height: 32,
              color: genSmall === 0 && genLarge === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.82)',
              cursor: genSmall === 0 && genLarge === 0 ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
              transition: 'all 0.12s',
            }}
            onMouseEnter={e => {
              if (genSmall > 0 || genLarge > 0) {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.18)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = genSmall === 0 && genLarge === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.1)';
              (e.currentTarget as HTMLButtonElement).style.color = genSmall === 0 && genLarge === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.82)';
            }}
          >
            Generiši
          </button>
        </div>

        {/* ── Right: Export + Delete + Zoom + 2D/3D ── */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {modules.length > 0 && (
            <button
              onClick={handleExportPDF}
              style={{
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '6px 13px',
                color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
                fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s', display: 'flex', alignItems: 'center', gap: 5,
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)';
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.6)';
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.7 }}>
                <path d="M3 4h2V1h6v3h2L8 9 3 4zm-1 8h12v2H2v-2z" fill="currentColor"/>
              </svg>
              PDF
            </button>
          )}

          {modules.length > 0 && (
            <button
              onClick={() => setModules([])}
              style={{
                background: 'transparent', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8, padding: '6px 13px',
                color: 'rgba(255,255,255,0.25)', cursor: 'pointer',
                fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.color = '#f87171';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(248,113,113,0.3)';
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.06)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.25)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.07)';
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              Obriši
            </button>
          )}

          {/* Zoom controls — 2D only */}
          {view === '2d' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
              <button
                onClick={() => changeZoom(-ZOOM_STEP)}
                disabled={zoom <= ZOOM_MIN}
                title="Zoom out"
                style={{
                  width: 32, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '7px 0 0 7px', border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 16,
                  opacity: zoom <= ZOOM_MIN ? 0.3 : 1, transition: 'background 0.12s',
                }}
                onMouseEnter={e => { if (zoom > ZOOM_MIN) (e.currentTarget.style.background = 'rgba(255,255,255,0.09)'); }}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
              >−</button>
              <button
                onClick={() => setZoom(1)}
                title="Reset zoom"
                style={{
                  minWidth: 50, height: 30,
                  borderTop: '1px solid rgba(255,255,255,0.1)', borderBottom: '1px solid rgba(255,255,255,0.1)',
                  borderLeft: 'none', borderRight: 'none',
                  background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.42)', cursor: 'pointer',
                  fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.09)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.8)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.42)';
                }}
              >{Math.round(zoom * 100)}%</button>
              <button
                onClick={() => changeZoom(ZOOM_STEP)}
                disabled={zoom >= ZOOM_MAX}
                title="Zoom in"
                style={{
                  width: 32, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: '0 7px 7px 0', border: '1px solid rgba(255,255,255,0.1)',
                  background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 16,
                  opacity: zoom >= ZOOM_MAX ? 0.3 : 1, transition: 'background 0.12s',
                }}
                onMouseEnter={e => { if (zoom < ZOOM_MAX) (e.currentTarget.style.background = 'rgba(255,255,255,0.09)'); }}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
              >+</button>
            </div>
          )}

          {/* 2D / 3D segmented control */}
          <div style={{
            display: 'flex', alignItems: 'center',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.09)',
            borderRadius: 9, padding: 2,
          }}>
            <button
              onClick={() => setView('2d')}
              style={{
                padding: '4px 15px', borderRadius: 7, border: 'none',
                background: view === '2d' ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: view === '2d' ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
                transition: 'all 0.15s', whiteSpace: 'nowrap',
                boxShadow: view === '2d' ? '0 1px 3px rgba(0,0,0,0.35)' : 'none',
              }}
            >2D</button>
            <button
              onClick={() => setView('3d')}
              style={{
                padding: '4px 15px', borderRadius: 7, border: 'none',
                background: view === '3d' ? 'rgba(255,255,255,0.12)' : 'transparent',
                color: view === '3d' ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                cursor: 'pointer', fontSize: 13, fontWeight: 600,
                transition: 'all 0.15s', whiteSpace: 'nowrap',
                boxShadow: view === '3d' ? '0 1px 3px rgba(0,0,0,0.35)' : 'none',
              }}
            >3D</button>
          </div>
        </div>
      </header>

      {/* ── Stats bar ────────────────────────────────────────────── */}
      <div style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: '#0a0a0d',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        height: 40,
        flexShrink: 0,
        fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
      }}>
        {/* Module counts */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#71717a', flexShrink: 0, display: 'block' }} />
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.38)', letterSpacing: '0.01em' }}>Mali</span>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.82)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 12 }}>{smallCount}</span>
        </div>
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.07)', margin: '0 14px' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#c8c8c8', flexShrink: 0, display: 'block' }} />
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.38)', letterSpacing: '0.01em' }}>Veliki</span>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.82)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 12 }}>{largeCount}</span>
        </div>
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.07)', margin: '0 22px' }} />
        {/* Gabarit */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.07em', textTransform: 'uppercase' as const, fontWeight: 500 }}>Gabarit</span>
          <span style={{
            fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
            color: bbox ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.18)',
          }}>
            {bbox ? `${bbox.w.toFixed(1)} × ${bbox.h.toFixed(1)} m` : '— × — m'}
          </span>
        </div>
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.07)', margin: '0 22px' }} />
        {/* Površina */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.07em', textTransform: 'uppercase' as const, fontWeight: 500 }}>Površina</span>
          <span style={{
            fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
            color: totalArea > 0 ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.18)',
          }}>
            {totalArea > 0 ? `${totalArea.toFixed(2)} m²` : '—'}
          </span>
        </div>
      </div>

      {/* ── Grid area ─────────────────────────────────────────────── */}
      {view === '2d' ? (
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto p-8"
        onWheel={handleWheel}
        style={{ cursor: drag ? 'grabbing' : 'default' }}
      >
        {/* Spacer so scrollbar tracks the zoomed size */}
        <div style={{ width: COLS * CELL * zoom, height: ROWS * CELL * zoom, position: 'relative', flexShrink: 0 }}>
          {/* Actual grid — scaled from top-left */}
          <div
            ref={gridRef}
            style={{
              position:        'absolute',
              top:             0,
              left:            0,
              transformOrigin: 'top left',
              transform:       `scale(${zoom})`,
              width:           COLS * CELL,
              height:          ROWS * CELL,
              backgroundColor: '#0f0f12',
              // Two dot layers: full-cell (bright) + half-cell (dim)
              backgroundImage: [
                `radial-gradient(circle, rgba(255,255,255,0.22) 1.5px, transparent 1.5px)`,
                `radial-gradient(circle, rgba(255,255,255,0.07) 1px,   transparent 1px)`,
              ].join(', '),
              backgroundSize: [
                `${CELL}px ${CELL}px`,
                `${CELL / 2}px ${CELL / 2}px`,
              ].join(', '),
              backgroundPosition: [
                `${CELL / 2}px ${CELL / 2}px`,
                `${CELL / 4}px ${CELL / 4}px`,
              ].join(', '),
              borderRadius: 16,
              border:       '1px solid rgba(255,255,255,0.05)',
            }}
          >
          {/* ── Placed modules ── */}
          {modules.map(m => {
            const { w, h } = moduleSize(m);
            const isSmall       = m.type === 'small';
            const isBeingDragged = drag?.id === m.id;

            return (
              <div
                key={m.id}
                onMouseDown={e => handleMouseDown(e, m.id)}
                style={{
                  position:   'absolute',
                  left:       m.col * CELL,
                  top:        m.row * CELL,
                  width:      w * CELL,
                  height:     h * CELL,
                  padding:    6,
                  zIndex:     isBeingDragged ? 0 : 2,
                  opacity:    isBeingDragged ? 0.3 : 1,
                  cursor:     drag ? 'grabbing' : 'grab',
                  transition: isBeingDragged ? 'none' : 'opacity 0.12s',
                }}
              >
                <div
                  style={{
                    width:         '100%',
                    height:        '100%',
                    borderRadius:  14,
                    background:    isSmall ? '#71717a' : '#ffffff',
                    position:      'relative',
                    overflow:      'hidden',
                    boxShadow:     isSmall ? '0 4px 20px rgba(0,0,0,0.45)' : '0 4px 24px rgba(0,0,0,0.3)',
                  }}
                >
                  {/* Roof eave indicator — 4 orientations
                      0=LEFT(▶)  1=TOP(▼)  2=RIGHT(◀)  3=BOTTOM(▲) */}
                  {!isSmall && (() => {
                    const r = m.rotation;
                    const grad = [
                      'linear-gradient(to right,  rgba(0,0,0,0.06) 0%, transparent 60%)',
                      'linear-gradient(to bottom, rgba(0,0,0,0.06) 0%, transparent 60%)',
                      'linear-gradient(to left,   rgba(0,0,0,0.06) 0%, transparent 60%)',
                      'linear-gradient(to top,    rgba(0,0,0,0.06) 0%, transparent 60%)',
                    ][r];
                    return (
                      <>
                        <div style={{ position: 'absolute', inset: 0, borderRadius: 13, pointerEvents: 'none', background: grad }} />
                        {r === 0 && <div style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, left: 7, top: 8, bottom: 8, width: 0, borderLeft: '1.5px dashed rgba(0,0,0,0.2)' }} />}
                        {r === 1 && <div style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, top: 7, left: 8, right: 8, height: 0, borderTop: '1.5px dashed rgba(0,0,0,0.2)' }} />}
                        {r === 2 && <div style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, right: 7, top: 8, bottom: 8, width: 0, borderRight: '1.5px dashed rgba(0,0,0,0.2)' }} />}
                        {r === 3 && <div style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, bottom: 7, left: 8, right: 8, height: 0, borderBottom: '1.5px dashed rgba(0,0,0,0.2)' }} />}
                        {r === 0 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 9, color: 'rgba(0,0,0,0.3)', left: 10, top: '50%', transform: 'translateY(-50%)' }}>▶</span>}
                        {r === 1 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 9, color: 'rgba(0,0,0,0.3)', top: 10, left: '50%', transform: 'translateX(-50%)' }}>▼</span>}
                        {r === 2 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 9, color: 'rgba(0,0,0,0.3)', right: 10, top: '50%', transform: 'translateY(-50%)' }}>◀</span>}
                        {r === 3 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 9, color: 'rgba(0,0,0,0.3)', bottom: 10, left: '50%', transform: 'translateX(-50%)' }}>▲</span>}
                      </>
                    );
                  })()}

                  {/* Action buttons — top-right corner, always visible */}
                  <div style={{
                    position: 'absolute', top: 14, right: 14,
                    display: 'flex', gap: 4, zIndex: 1,
                  }}>
                    {!isSmall && (
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); rotateModule(m.id); }}
                        title="Rotiraj"
                        style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: 'rgba(0,0,0,0.08)',
                          border: 'none', cursor: 'pointer', color: '#333',
                          fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'background 0.15s', flexShrink: 0,
                        }}
                        onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.16)')}
                        onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.08)')}
                      >↻</button>
                    )}
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); removeModule(m.id); }}
                      title="Ukloni"
                      style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: isSmall ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
                        border: 'none', cursor: 'pointer', color: isSmall ? '#fff' : '#333',
                        fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s', flexShrink: 0,
                      }}
                      onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.5)')}
                      onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = isSmall ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)')}
                    >✕</button>
                  </div>

                  {/* Label — bottom-left, always shown at CELL=120 */}
                  {(w * CELL > 40 && h * CELL > 40) && (
                    <div style={{ position: 'absolute', bottom: 14, left: 14 }}>
                      <p style={{ fontSize: Math.min(18, w * CELL * 0.11), fontWeight: 800, lineHeight: 1, margin: 0, color: isSmall ? '#fff' : '#1a1a2e' }}>
                        {isSmall ? 'MALI' : 'VELIKI'}
                      </p>
                      <p style={{ fontSize: 10, opacity: 0.45, margin: '3px 0 0', whiteSpace: 'nowrap', color: isSmall ? '#fff' : '#1a1a2e' }}>
                        {isSmall ? '2.4 × 2.4 m' : m.rotation % 2 !== 0 ? '2.4 × 4.8 m' : '4.8 × 2.4 m'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* ── Drag ghost ── */}
          {drag && draggingModule && (
            <div
              style={{
                position:     'absolute',
                left:         drag.ghostCol * CELL,
                top:          drag.ghostRow  * CELL,
                width:        moduleSize(draggingModule).w * CELL,
                height:       moduleSize(draggingModule).h * CELL,
                padding:      6,
                pointerEvents:'none',
                zIndex:       20,
              }}
            >
              <div
                style={{
                  width:        '100%',
                  height:       '100%',
                  borderRadius: 16,
                  border:       `2px dashed ${ghostValid ? 'rgba(255,255,255,0.5)' : 'rgba(239,68,68,0.7)'}`,
                  background:   ghostValid ? 'rgba(255,255,255,0.06)' : 'rgba(239,68,68,0.08)',
                  transition:   'border-color 0.1s, background 0.1s',
                }}
              />
            </div>
          )}
          </div>{/* end: scaled grid */}
        </div>{/* end: spacer */}

        {/* Legend */}
        <p style={{ marginTop: 16, fontSize: 11, color: '#374151' }}>
          Klikni i prevuci modul da ga pomeriš &nbsp;·&nbsp; ↻ rotiraj veliki modul &nbsp;·&nbsp; ✕ ukloni &nbsp;·&nbsp; Ctrl + scroll za zoom
        </p>
      </div>
      ) : (
      <div style={{ position: 'relative', height: 'calc(100vh - 56px)' }}>
        <Scene3D modules={modules} />
        {modules.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none',
          }}>
            <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: 15 }}>
              Nema modula — dodaj ih u 2D prikazu
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
