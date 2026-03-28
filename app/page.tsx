'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';

// ---------------------------------------------------------------------------
// Constants — 1 cell = 2.4 m in real life
// ---------------------------------------------------------------------------
const CELL         = 120;  // px (logical, before zoom)
const DEFAULT_COLS = 20;
const DEFAULT_ROWS = 14;
const GRID_MARGIN  = 3;   // cells of buffer before auto-expand triggers
const GRID_EXPAND  = 4;   // cells added per expansion
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ModuleType = 'large' | 'small' | 'medium' | 'deck' | 'smalldeck';

interface LightSettings {
  isDay:        boolean;
  sunAngle:     number; // 0-359°, 0=Sever, 90=Istok, 180=Jug, 270=Zapad
  sunElevation: number; // 5-85°
}

type GrassType = 'trava' | 'suva' | 'zemlja' | 'pesak' | 'beton' | 'dark';
interface SceneSettings {
  grass:      GrassType;
  fogEnabled: boolean;
}

interface PlacedModule {
  id:      string;
  type:    ModuleType;
  glbFile: string;
  // Kontrole za grupe unutar large_full_modul.glb (17 grupa):
  hasKonstrukcija: boolean;
  hasStakleniKrov: boolean;
  hasFasada2PunZid: boolean;
  hasFasada1SaVratima: boolean;
  hasFasada1BezVrata: boolean;
  hasFasada4PodiznoKlizna: boolean;
  hasFasada4Fix: boolean;
  hasFasada4KupatiloProzor: boolean;
  hasFasada3ProzorSpavaca: boolean;
  hasFasada3PunZid: boolean;
  hasKrovPun: boolean;
  hasFasada4PunZid: boolean;
  // _R (desna strana) — samo large_full_modul.glb:
  hasFasada1SaVratimaR: boolean;
  hasFasada1BezVrataR: boolean;
  hasFasada1PunZidR: boolean;
  hasFasada3ProzorSpavacaR: boolean;
  hasFasada3PunZidR: boolean;
  // Polja za medium tip (small_v2_full.glb):
  hasFasada1PodiznoKlizna: boolean;
  hasFasada1Fix: boolean;
  hasFasada2PodiznoKlizna: boolean;
  hasFasada2Fix: boolean;
  hasFasada3PodiznoKlizna: boolean;
  hasFasada3Fix: boolean;
  hasFasada1PunZid: boolean;
  // Polja za deck tip (large_full_large_deck.glb):
  hasTerasaDeckOtkrivena: boolean;
  hasTerasaVelikaPergola: boolean;
  // Polja za smalldeck tip (large_full_small_deck.glb):
  hasTerasaDeckMala: boolean;
  hasMalaPergolaDesnagore: boolean;
  hasMalaPergolaLevaGore: boolean;
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
  // Small modul je uvek 1x1
  if (m.type === 'small' || m.type === 'medium' || m.type === 'smalldeck') {
    return { w: 1, h: 1 };
  }
  // Large modul ima rotation-dependent footprint
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

function inBounds(m: PlacedModule, cols: number, rows: number): boolean {
  const { w, h } = moduleSize(m);
  return m.col >= 0 && m.row >= 0 && m.col + w <= cols && m.row + h <= rows;
}

function firstFreePosition(
  type:     ModuleType,
  rotation: 0 | 1 | 2 | 3,
  placed:   PlacedModule[],
  cols:     number,
  rows:     number,
): { col: number; row: number } | null {
  const dummy = { id: '__test__', type, col: 0, row: 0, rotation } as PlacedModule;
  // Step by 0.5 so auto-placement also respects the half-cell grid
  for (let row = 0; row < rows; row += 0.5) {
    for (let col = 0; col < cols; col += 0.5) {
      const candidate = { ...dummy, col, row };
      if (inBounds(candidate, cols, rows) && !placed.some(m => overlaps(candidate, m))) {
        return { col, row };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generator — simplified for custom modules only
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function generateLayout(smallCount: number, largeCount: number, tallCount: number, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): PlacedModule[] {
  // GLB mode doesn't use auto-generation - return empty array
  return [];
}

// ---------------------------------------------------------------------------
// Scene3D — Three.js 3D preview
// ---------------------------------------------------------------------------

/** Procedural canvas texture for each ground type */
function createGroundTexture(type: GrassType): THREE.CanvasTexture {
  const SIZE = 512;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;

  // Deterministic hash noise (no external deps)
  const h  = (x: number, y: number, s = 0) => { const n = Math.sin(x * 127.1 + y * 311.7 + s * 74.3) * 43758.5453; return n - Math.floor(n); };
  const bi = (x: number, y: number, s = 0) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy); return h(xi,yi,s)*(1-ux)*(1-uy)+h(xi+1,yi,s)*ux*(1-uy)+h(xi,yi+1,s)*(1-ux)*uy+h(xi+1,yi+1,s)*ux*uy; };
  const fbm = (x: number, y: number, s = 0) => bi(x,y,s)*0.50 + bi(x*2,y*2,s+7)*0.25 + bi(x*4,y*4,s+13)*0.125 + bi(x*8,y*8,s+19)*0.0625;
  const cl  = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

  // Base pixel noise layer
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (y * SIZE + x) * 4;
      const n  = fbm(x / 64, y / 64);
      const n2 = bi(x / 20, y / 20, 3);
      let r = 0, g = 0, b = 0;
      if (type === 'trava') {
        r = cl(38  + n*38  + n2*18); g = cl(95  + n*60  + n2*28); b = cl(22  + n*18);
      } else if (type === 'suva') {
        r = cl(158 + n*50  + n2*22); g = cl(128 + n*42  + n2*15); b = cl(55  + n*22);
      } else if (type === 'zemlja') {
        r = cl(95  + n*45  + n2*20); g = cl(60  + n*28  + n2*12); b = cl(25  + n*15);
      } else if (type === 'pesak') {
        r = cl(205 + n*28  + n2*12); g = cl(182 + n*26  + n2*10); b = cl(112 + n*22);
      } else {  // beton
        const gr = cl(148 + n*28 + n2*14);
        r = gr; g = gr; b = gr;
      }
      d[idx]=r; d[idx+1]=g; d[idx+2]=b; d[idx+3]=255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Detail overlay per type
  ctx.save();
  if (type === 'trava') {
    for (let i = 0; i < 3500; i++) {
      const bx = h(i,0,20)*SIZE, by = h(i,0,21)*SIZE;
      const len = 4 + h(i,0,22)*10;
      const ang = -Math.PI/2 + (h(i,0,23)-0.5)*1.3;
      ctx.strokeStyle = `rgba(${cl(18+h(i,0,24)*40)},${cl(65+h(i,0,25)*75)},${cl(6+h(i,0,26)*22)},0.55)`;
      ctx.lineWidth = 0.4 + h(i,0,27)*0.7;
      ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(bx+Math.cos(ang)*len, by+Math.sin(ang)*len); ctx.stroke();
    }
  } else if (type === 'suva') {
    for (let i = 0; i < 2800; i++) {
      const bx = h(i,1,30)*SIZE, by = h(i,1,31)*SIZE;
      const len = 5 + h(i,1,32)*14;
      const ang = (h(i,1,33)-0.5)*Math.PI*0.5;
      ctx.strokeStyle = `rgba(${cl(160+h(i,1,34)*55)},${cl(110+h(i,1,35)*45)},${cl(22+h(i,1,36)*32)},0.45)`;
      ctx.lineWidth = 0.4 + h(i,1,37)*0.6;
      ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(bx+Math.cos(ang)*len, by+Math.sin(ang)*len); ctx.stroke();
    }
  } else if (type === 'zemlja') {
    for (let i = 0; i < 350; i++) {
      const bx = h(i,2,40)*SIZE, by = h(i,2,41)*SIZE;
      const rr = 1.2 + h(i,2,42)*3.5;
      const lum = 50 + Math.round(h(i,2,43)*65);
      ctx.beginPath();
      ctx.ellipse(bx, by, rr, rr*(0.55+h(i,2,44)*0.55), h(i,2,45)*Math.PI, 0, Math.PI*2);
      ctx.fillStyle = `rgba(${lum+28},${lum},${lum-18},0.65)`;
      ctx.fill();
    }
  } else if (type === 'pesak') {
    for (let row = 0; row < 35; row++) {
      const baseY = row*(SIZE/35) + h(row,3,50)*6;
      ctx.beginPath(); ctx.moveTo(0, baseY);
      for (let xi = 0; xi <= SIZE; xi += 3) {
        ctx.lineTo(xi, baseY + bi(xi/40, row/6, 55)*7-3.5);
      }
      ctx.strokeStyle = 'rgba(165,138,72,0.14)'; ctx.lineWidth = 0.9; ctx.stroke();
    }
  } else {
    // Concrete: expansion joint grid
    const sl = SIZE/4;
    ctx.strokeStyle = 'rgba(70,70,70,0.38)'; ctx.lineWidth = 1.8;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(i*sl,0); ctx.lineTo(i*sl,SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0,i*sl); ctx.lineTo(SIZE,i*sl); ctx.stroke();
    }
    // Fine surface cracks
    for (let i = 0; i < 10; i++) {
      ctx.beginPath(); ctx.moveTo(h(i,4,60)*SIZE, h(i,4,61)*SIZE);
      let cx2 = h(i,4,60)*SIZE, cy2 = h(i,4,61)*SIZE;
      for (let seg = 0; seg < 6; seg++) { cx2+=(h(i,seg,62)-0.5)*18; cy2+=(h(i,seg,63)-0.5)*18; ctx.lineTo(cx2,cy2); }
      ctx.strokeStyle = 'rgba(55,55,55,0.18)'; ctx.lineWidth = 0.5; ctx.stroke();
    }
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(45, 45);
  return tex;
}

const GRASS_COLORS: Record<GrassType, number> = {
  trava:  0x9aab8c,
  suva:   0xb8a96a,
  zemlja: 0x7a5c3a,
  pesak:  0xd4c08a,
  beton:  0xaaaaaa,
  dark:   0x232330,
};

function Scene3D({ modules, cols, rows, lightSettings, sceneSettings, isDrawingMode, clearAnnotationsRef, onAnnotationAdded, savedCameraRef, savedAnnotationsRef, onFillClick, exportSTLRef }: {
  modules: PlacedModule[];
  cols: number;
  rows: number;
  lightSettings: LightSettings;
  sceneSettings: SceneSettings;
  isDrawingMode: boolean;
  clearAnnotationsRef: React.MutableRefObject<(() => void) | null>;
  onAnnotationAdded: () => void;
  savedCameraRef: React.MutableRefObject<{ position: THREE.Vector3; target: THREE.Vector3 } | null>;
  savedAnnotationsRef: React.MutableRefObject<THREE.Mesh[]>;
  onFillClick: (mesh: THREE.Mesh, screenX: number, screenY: number) => void;
  exportSTLRef: React.MutableRefObject<(() => void) | null>;
}) {
  const mountRef     = useRef<HTMLDivElement>(null);
  const rendererRef  = useRef<THREE.WebGLRenderer | null>(null);
  const dirLightRef  = useRef<THREE.DirectionalLight | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight  | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);
  const sceneRef     = useRef<THREE.Scene            | null>(null);
  const cameraRef    = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef  = useRef<OrbitControls          | null>(null);
  const annoGroupRef = useRef<THREE.Group             | null>(null);
  const floorMatRef       = useRef<THREE.MeshStandardMaterial | null>(null);
  const gridHelperLightRef = useRef<THREE.GridHelper | null>(null);
  const gridHelperDarkRef  = useRef<THREE.GridHelper | null>(null);
  const floorSizeRef = useRef(80);
  const centerXRef   = useRef(0);
  const centerZRef   = useRef(0);
  const onFillClickRef = useRef(onFillClick);
  onFillClickRef.current = onFillClick;
  const lightSettingsRef  = useRef(lightSettings);
  const sceneSettingsRef  = useRef(sceneSettings);
  lightSettingsRef.current = lightSettings;
  sceneSettingsRef.current = sceneSettings;

  const applyLighting = useCallback((ls: LightSettings) => {
    const dirLight  = dirLightRef.current;
    const hemi      = hemiLightRef.current;
    const fillLight = fillLightRef.current;
    const renderer  = rendererRef.current;
    const scene     = sceneRef.current;
    if (!dirLight || !hemi || !fillLight || !renderer || !scene) return;
    const cX = centerXRef.current;
    const cZ = centerZRef.current;
    const elevRad = (ls.sunElevation * Math.PI) / 180;
    const azRad   = (ls.sunAngle     * Math.PI) / 180;
    const dist    = 70;
    const hDist   = dist * Math.cos(elevRad);
    const lx = cX + Math.sin(azRad) * hDist;
    const ly = dist * Math.sin(elevRad);
    const lz = cZ - Math.cos(azRad) * hDist;
    const isDarkGround = sceneSettingsRef.current.grass === 'dark';
    if (ls.isDay) {
      renderer.toneMappingExposure = isDarkGround ? 1.0 : 1.4;
      if (!isDarkGround) {
        (scene.background as THREE.Color).setHex(0x87ceeb);
        (scene.fog as THREE.FogExp2).color.setHex(0xb0d8f0);
        (scene.fog as THREE.FogExp2).density = 0.003;
      }
      hemi.color.setHex(isDarkGround ? 0x3464a0 : 0xb0d4ff);
      hemi.groundColor.setHex(isDarkGround ? 0x1a1a28 : 0x8a9a70);
      hemi.intensity = isDarkGround ? 0.7 : 1.2;
      dirLight.color.setHex(isDarkGround ? 0xfff5e8 : 0xfff8e7);
      dirLight.intensity = isDarkGround ? 2.0 : 3.5;
      dirLight.position.set(lx, ly, lz);
      fillLight.color.setHex(isDarkGround ? 0x6a90c0 : 0xd0e8ff);
      fillLight.intensity = isDarkGround ? 0.9 : 1.2;
      fillLight.position.set(cX - Math.sin(azRad) * 35, 25, cZ + Math.cos(azRad) * 35);
    } else {
      renderer.toneMappingExposure = isDarkGround ? 1.0 : 0.7;
      if (!isDarkGround) {
        (scene.background as THREE.Color).setHex(0x050d1a);
        (scene.fog as THREE.FogExp2).color.setHex(0x050d1a);
        (scene.fog as THREE.FogExp2).density = 0.005;
      }
      hemi.color.setHex(isDarkGround ? 0x3464a0 : 0x1a2a4a);
      hemi.groundColor.setHex(isDarkGround ? 0x1a1a28 : 0x050508);
      hemi.intensity = isDarkGround ? 0.7 : 0.25;
      dirLight.color.setHex(isDarkGround ? 0xfff5e8 : 0xb0c8e8);
      dirLight.intensity = isDarkGround ? 2.0 : 0.7;
      dirLight.position.set(lx, ly, lz);
      fillLight.color.setHex(isDarkGround ? 0x6a90c0 : 0x1a2a4a);
      fillLight.intensity = isDarkGround ? 0.9 : 0.15;
      fillLight.position.set(cX - Math.sin(azRad) * 35, 25, cZ + Math.cos(azRad) * 35);
    }
    dirLight.shadow.camera.updateProjectionMatrix();
  }, []);

  const applyScene = useCallback((ss: SceneSettings) => {
    const mat   = floorMatRef.current;
    const scene = sceneRef.current;
    if (!mat || !scene) return;

    // Toggle light/dark grid helper
    if (gridHelperLightRef.current) gridHelperLightRef.current.visible = ss.grass !== 'dark';
    if (gridHelperDarkRef.current)  gridHelperDarkRef.current.visible  = ss.grass === 'dark';

    if (ss.grass === 'dark') {
      // Old-style dark scene (dark navy background + grid)
      if (mat.map) { mat.map.dispose(); mat.map = null; }
      mat.color.setHex(0x232330);
      mat.roughness = 0.88;
      mat.metalness = 0.05;
      mat.needsUpdate = true;
      (scene.background as THREE.Color).setHex(0x1b3458);
      (scene.fog as THREE.FogExp2).color.setHex(0x1b3458);
      (scene.fog as THREE.FogExp2).density = 0.006;
      return;
    }

    // Switching back from dark mode — restore sky based on current lighting
    (scene.background as THREE.Color).setHex(lightSettingsRef.current.isDay ? 0x87ceeb : 0x050d1a);
    (scene.fog as THREE.FogExp2).color.setHex(lightSettingsRef.current.isDay ? 0xb0d8f0 : 0x050d1a);

    if (mat.map) { mat.map.dispose(); mat.map = null; }
    if (ss.grass === 'trava') {
      const tex = new THREE.TextureLoader().load('/grass.jpg', (t) => {
        const repeats = floorSizeRef.current / 5;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repeats, repeats);
        t.colorSpace = THREE.SRGBColorSpace;
        mat.map = t;
        mat.color.setHex(0xffffff);
        mat.roughness = 0.85;
        mat.needsUpdate = true;
      });
      void tex;
    } else {
      mat.map = createGroundTexture(ss.grass);
      mat.color.setHex(0xffffff);
    }
    const roughnessMap: Record<GrassType, number> = { trava: 0.92, suva: 0.88, zemlja: 0.95, pesak: 0.78, beton: 0.65, dark: 0.88 };
    mat.roughness = roughnessMap[ss.grass];
    mat.needsUpdate = true;
    (scene.fog as THREE.FogExp2).density = ss.fogEnabled ? 0.003 : 0;
  }, []);

  useEffect(() => {
    applyLighting(lightSettings);
  }, [lightSettings, applyLighting]);

  useEffect(() => {
    applyScene(sceneSettings);
  }, [sceneSettings, applyScene]);

  useEffect(() => {
    const mount = mountRef.current!;
    // Read dimensions after mount; fall back to window size if the element
    // hasn't been laid-out yet (clientWidth/Height === 0).
    const w = mount.clientWidth  || window.innerWidth;
    const h = mount.clientHeight || (window.innerHeight - 56);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    rendererRef.current = renderer;
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x87ceeb);
    mount.appendChild(renderer.domElement);

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.FogExp2(0xb0d8f0, 0.003);

    // Compute center from placed modules (or fall back to grid centre)
    let centerX: number, centerZ: number;
    if (modules.length === 0) {
      centerX = (cols / 2) * 2.4;
      centerZ = (rows / 2) * 2.4;
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

    // Camera — restore saved position if available, otherwise use default
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
    if (savedCameraRef.current) {
      camera.position.copy(savedCameraRef.current.position);
    } else {
      camera.position.set(centerX, 22, centerZ + 28);
    }
    camera.lookAt(centerX, 0, centerZ);
    cameraRef.current = camera;

    // Persistent annotation group — survives drawing mode toggles
    // Restore any previously saved annotation meshes from before 2D switch
    const annoGroup = new THREE.Group();
    annoGroupRef.current = annoGroup;
    scene.add(annoGroup);
    for (const mesh of savedAnnotationsRef.current) {
      // Reset any leftover selection material before re-adding to scene
      if (mesh.userData._prevMat) { mesh.material = mesh.userData._prevMat as THREE.Material; delete mesh.userData._prevMat; }
      annoGroup.add(mesh);
    }
    clearAnnotationsRef.current = () => {
      annoGroup.clear();
      savedAnnotationsRef.current = [];
    };

    exportSTLRef.current = () => {
      const sc = sceneRef.current;
      if (!sc) return;
      sc.updateMatrixWorld(true);
      const exportGroup = new THREE.Group();
      sc.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        // skip annotations and fills
        if (mesh.userData.ptA || mesh.userData.isFill) return;
        // skip invisible (check whole ancestor chain)
        let visible = true;
        let cur: THREE.Object3D | null = mesh;
        while (cur) { if (!cur.visible) { visible = false; break; } cur = cur.parent; }
        if (!visible) return;
        // only include meshes that live inside a module-* group
        let inModule = false;
        let par: THREE.Object3D | null = mesh.parent;
        while (par) { if (par.name.startsWith('module-')) { inModule = true; break; } par = par.parent; }
        if (!inModule) return;
        const clonedGeo = mesh.geometry.clone();
        clonedGeo.applyMatrix4(mesh.matrixWorld);
        const clonedMesh = new THREE.Mesh(clonedGeo);
        exportGroup.add(clonedMesh);
      });
      if (exportGroup.children.length === 0) return;
      const exporter = new STLExporter();
      const stlData = exporter.parse(exportGroup, { binary: true });
      const blob = new Blob([stlData as unknown as ArrayBuffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `modular-${Date.now()}.stl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    // Lights — colors & positions applied dynamically via applyLighting()
    const hemi = new THREE.HemisphereLight(0xb0d4ff, 0x8a9a70, 1.2);
    scene.add(hemi);

    const dirLight = new THREE.DirectionalLight(0xfff8e7, 3.5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width  = 4096;
    dirLight.shadow.mapSize.height = 4096;
    dirLight.shadow.camera.near   = 0.5;
    dirLight.shadow.camera.far    = 300;
    dirLight.shadow.camera.left   = -80;
    dirLight.shadow.camera.right  =  80;
    dirLight.shadow.camera.top    =  80;
    dirLight.shadow.camera.bottom = -80;
    dirLight.shadow.bias = -0.0003;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xd0e8ff, 1.2);
    scene.add(fillLight);

    // Store refs & apply current lighting
    hemiLightRef.current  = hemi;
    dirLightRef.current   = dirLight;
    fillLightRef.current  = fillLight;
    sceneRef.current      = scene;
    centerXRef.current    = centerX;
    centerZRef.current    = centerZ;
    applyLighting(lightSettingsRef.current);

    // Floor
    const floorSize = cols * 2.4 + 60;
    floorSizeRef.current = floorSize;
    const floorGeo = new THREE.PlaneGeometry(floorSize, floorSize);
    const floorMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    floorMatRef.current = floorMat;
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centerX, 0, centerZ);
    floor.receiveShadow = true;
    scene.add(floor);
    applyScene(sceneSettingsRef.current);

    // Grid lines — two helpers: one for day/outdoor, one for dark mode
    const gridSize = Math.max(cols, rows) * 2.4 + 10;
    const gridDivs = Math.max(cols, rows) + 4;
    const gridHelperLight = new THREE.GridHelper(gridSize, gridDivs, 0x6a7c5a, 0x7a8e68);
    gridHelperLight.position.set(centerX, 0.01, centerZ);
    scene.add(gridHelperLight);
    gridHelperLightRef.current = gridHelperLight;

    const gridHelperDark = new THREE.GridHelper(gridSize, gridDivs, 0x2d2d3c, 0x272732);
    gridHelperDark.position.set(centerX, 0.01, centerZ);
    scene.add(gridHelperDark);
    gridHelperDarkRef.current = gridHelperDark;

    // Initial visibility based on current scene settings
    const initDark = sceneSettingsRef.current.grass === 'dark';
    gridHelperLight.visible = !initDark;
    gridHelperDark.visible  = initDark;

    // Modules — rendered as GLB models only

    // Custom GLB modules — loaded async via GLTFLoader
    const customMeshes: THREE.Object3D[] = [];
    if (modules.length > 0) {
      const loader = new GLTFLoader();
      modules.forEach(m => {
        // ═══════════════════════════════════════════════════════════════
        // UVEK UČITAVA large_full_modul.glb SA KONTROLOM VIDLJIVOSTI GRUPA
        // ═══════════════════════════════════════════════════════════════
        
        const moduleGroup = new THREE.Group();
        moduleGroup.name = `module-${m.id}`;
        
        // Fiksne dimenzije - zavisi od tipa modula
        const FIXED_WIDTH = (m.type === 'large' || m.type === 'deck') ? 4.8 : 2.4;  // Large/Deck: 2 ćelije (4.8m), Small/Medium/SmallDeck: 1 ćelija (2.4m)
        const FIXED_DEPTH = m.type === 'large' ? 2.4 : 2.4;  // Large: 1 ćelija (2.4m), Small: 1 ćelija (2.4m)
        
        // Izračunaj grid poziciju
        const { w: gridW, h: gridH } = moduleSize(m);
        const gridX = m.col * 2.4;
        const gridZ = m.row * 2.4;
        const footprintWidth = gridW * 2.4;
        const footprintDepth = gridH * 2.4;
        const footprintCenterX = gridX + footprintWidth / 2;
        const footprintCenterZ = gridZ + footprintDepth / 2;
        
        // Učitaj GLB fajl (large_full.glb ili small_full.glb)
        loader.load(`/modules/${m.glbFile}`, (gltf) => {
          const modulModel = gltf.scene.clone();
          modulModel.name = m.type === 'large' ? 'large-full' : m.type === 'deck' ? 'deck-full' : m.type === 'smalldeck' ? 'smalldeck-full' : m.type === 'medium' ? 'medium-full' : 'small-full';
          
          // Pronađi sve grupe po imenu (12 grupa)
          const konstrukcijaGroup = modulModel.getObjectByName('konstrukcija');
          const stakleniKrovGroup = modulModel.getObjectByName('stakleni_krov');
          const fasada2PunZidGroup = modulModel.getObjectByName('fasada_2_pun_zid');
          const fasada1SaVratimaGroup = modulModel.getObjectByName('fasada_1_sa_vratima');
          const fasada1BezVrataGroup = modulModel.getObjectByName('fasada_1_bez_vrata');
          const fasada4PodiznoKliznaGroup = modulModel.getObjectByName('fasada_4_podizno_klizniiiiiii');
          const fasada4FixGroup = modulModel.getObjectByName('fasada_4_fix');
          const fasada4KupatiloProzorGroup = modulModel.getObjectByName('fasada_4_kupatilo_prozor');
          const fasada3ProzorSpavacaGroup = modulModel.getObjectByName('fasada_3_prozor_spavaca');
          const fasada3PunZidGroup = modulModel.getObjectByName('fasada_3_pun_zid');
          const krovPunGroup = modulModel.getObjectByName('krov_pun');
          const fasada4PunZidGroup = modulModel.getObjectByName('fasada_4_pun_zid');
          // Medium-specific groups (small_v2_full.glb)
          const fasada1PodiznoKliznaGroup = modulModel.getObjectByName('fasada_1_podizno_klizniiiiiii');
          const fasada1FixGroup = modulModel.getObjectByName('fasada_1_fix');
          const fasada2PodiznoKliznaGroup = modulModel.getObjectByName('fasada_2_podizno_klizniiiiiii');
          const fasada2FixGroup = modulModel.getObjectByName('fasada_2_fix');
          const fasada3PodiznoKliznaGroup = modulModel.getObjectByName('fasada_3_podizno_klizniiiiiii');
          const fasada3FixGroup = modulModel.getObjectByName('fasada_3_fix');
          const fasada1PunZidGroup = modulModel.getObjectByName('fasada_1_pun_zid');
          // Large _R groups (large_full_modul.glb — desna strana)
          const fasada1SaVratimaRGroup = modulModel.getObjectByName('fasada_1_sa_vratima_R');
          const fasada1BezVrataRGroup  = modulModel.getObjectByName('fasada_1_bez_vrata_R');
          const fasada1PunZidRGroup    = modulModel.getObjectByName('fasada_1_pun_zid_R');
          const fasada3ProzorSpavacaRGroup = modulModel.getObjectByName('fasada_3_prozor_spavaca_R');
          const fasada3PunZidRGroup    = modulModel.getObjectByName('fasada_3_pun_zid_R');
          // Deck-specific groups (large_full_large_deck.glb)
          const terasaDeckOtkrivenaGroup = modulModel.getObjectByName('terasa_deck_otkrivena');
          const terasaVelikaPergolaGroup = modulModel.getObjectByName('terasa_velika_pergola');
          // SmallDeck-specific groups (large_full_small_deck.glb)
          const terasaDeckMalaGroup = modulModel.getObjectByName('terasa_deck_mala');
          const malaPergolaDesnagoreGroup = modulModel.getObjectByName('mala_pergola_desna_gore');
          const malaPergolaLevaGoreGroup = modulModel.getObjectByName('mala_pergola_leva_gore');
          
          // Izmeri model
          const bbox = new THREE.Box3().setFromObject(modulModel);
          const originalSize = bbox.getSize(new THREE.Vector3());
          
          // Uniformno skaliranje - Small modul treba dodatno da se smanji jer je 1x1 umesto 2x1
          const scaleX = FIXED_WIDTH / originalSize.x;
          const scaleZ = FIXED_DEPTH / originalSize.z;
          let uniformScale = Math.min(scaleX, scaleZ);
          
          modulModel.scale.set(uniformScale, uniformScale, uniformScale);
          
          // Update i izmeri
          modulModel.updateMatrixWorld(true);
          const bboxScaled = new THREE.Box3().setFromObject(modulModel);
          const centerScaled = bboxScaled.getCenter(new THREE.Vector3());
          
          // Pozicioniranje u lokalnom koordinatnom sistemu grupe
          modulModel.position.set(
            -centerScaled.x,
            -bboxScaled.min.y,  // Postavi na tlo
            -centerScaled.z
          );
          
          // Kontrola vidljivosti svih grupa (12 grupa)
          if (konstrukcijaGroup) konstrukcijaGroup.visible = m.hasKonstrukcija;
          if (stakleniKrovGroup) stakleniKrovGroup.visible = m.hasStakleniKrov;
          if (fasada2PunZidGroup) fasada2PunZidGroup.visible = m.hasFasada2PunZid;
          if (fasada1SaVratimaGroup) fasada1SaVratimaGroup.visible = m.hasFasada1SaVratima;
          if (fasada1BezVrataGroup) fasada1BezVrataGroup.visible = m.hasFasada1BezVrata;
          if (fasada4PodiznoKliznaGroup) fasada4PodiznoKliznaGroup.visible = m.hasFasada4PodiznoKlizna;
          if (fasada4FixGroup) fasada4FixGroup.visible = m.hasFasada4Fix;
          if (fasada4KupatiloProzorGroup) fasada4KupatiloProzorGroup.visible = m.hasFasada4KupatiloProzor;
          if (fasada3ProzorSpavacaGroup) fasada3ProzorSpavacaGroup.visible = m.hasFasada3ProzorSpavaca;
          if (fasada3PunZidGroup) fasada3PunZidGroup.visible = m.hasFasada3PunZid;
          if (krovPunGroup) krovPunGroup.visible = m.hasKrovPun;
          if (fasada4PunZidGroup) fasada4PunZidGroup.visible = m.hasFasada4PunZid;
          if (fasada1PodiznoKliznaGroup) fasada1PodiznoKliznaGroup.visible = m.hasFasada1PodiznoKlizna;
          if (fasada1FixGroup) fasada1FixGroup.visible = m.hasFasada1Fix;
          if (fasada2PodiznoKliznaGroup) fasada2PodiznoKliznaGroup.visible = m.hasFasada2PodiznoKlizna;
          if (fasada2FixGroup) fasada2FixGroup.visible = m.hasFasada2Fix;
          if (fasada3PodiznoKliznaGroup) fasada3PodiznoKliznaGroup.visible = m.hasFasada3PodiznoKlizna;
          if (fasada3FixGroup) fasada3FixGroup.visible = m.hasFasada3Fix;
          if (fasada1PunZidGroup) fasada1PunZidGroup.visible = m.hasFasada1PunZid;
          if (fasada1SaVratimaRGroup) fasada1SaVratimaRGroup.visible = m.hasFasada1SaVratimaR;
          if (fasada1BezVrataRGroup)  fasada1BezVrataRGroup.visible  = m.hasFasada1BezVrataR;
          if (fasada1PunZidRGroup)    fasada1PunZidRGroup.visible    = m.hasFasada1PunZidR;
          if (fasada3ProzorSpavacaRGroup) fasada3ProzorSpavacaRGroup.visible = m.hasFasada3ProzorSpavacaR;
          if (fasada3PunZidRGroup)    fasada3PunZidRGroup.visible    = m.hasFasada3PunZidR;
          if (terasaDeckOtkrivenaGroup) terasaDeckOtkrivenaGroup.visible = m.hasTerasaDeckOtkrivena;
          if (terasaVelikaPergolaGroup) terasaVelikaPergolaGroup.visible = m.hasTerasaVelikaPergola;
          if (terasaDeckMalaGroup) terasaDeckMalaGroup.visible = m.hasTerasaDeckMala;
          if (malaPergolaDesnagoreGroup) malaPergolaDesnagoreGroup.visible = m.hasMalaPergolaDesnagore;
          if (malaPergolaLevaGoreGroup) malaPergolaLevaGoreGroup.visible = m.hasMalaPergolaLevaGore;
          modulModel.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          
          // Dodaj u grupu
          moduleGroup.add(modulModel);
        }, undefined, (err) => console.warn(`[${m.glbFile}] load error:`, err));
        
        // Rotiraj celu grupu
        moduleGroup.rotation.y = -m.rotation * (Math.PI / 2);
        
        // Pozicioniraj celu grupu na grid
        moduleGroup.position.set(footprintCenterX, 0, footprintCenterZ);
        
        // Dodaj grupu u scenu
        scene.add(moduleGroup);
        customMeshes.push(moduleGroup);
      });
    }

    // OrbitControls — target the layout centre
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.06;
    const savedTarget = savedCameraRef.current?.target;
    controls.target.set(
      savedTarget ? savedTarget.x : centerX,
      savedTarget ? savedTarget.y : 0,
      savedTarget ? savedTarget.z : centerZ,
    );
    controls.minDistance    = 4;
    controls.maxDistance    = 200;
    controls.maxPolarAngle  = Math.PI / 2 - 0.02;
    controls.update();
    controlsRef.current = controls;

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
      // Save camera state before teardown
      savedCameraRef.current = {
        position: camera.position.clone(),
        target:   controls.target.clone(),
      };
      // Save annotation meshes before teardown so they survive the unmount
      const annoGroup = annoGroupRef.current;
      if (annoGroup) {
        savedAnnotationsRef.current = annoGroup.children.slice() as THREE.Mesh[];
        annoGroup.clear(); // detach from scene without disposing
      }
      cancelAnimationFrame(animId);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      customMeshes.forEach(obj => scene.remove(obj));
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      dirLightRef.current  = null;
      hemiLightRef.current = null;
      fillLightRef.current = null;
      floorMatRef.current  = null;
      sceneRef.current     = null;
      cameraRef.current    = null;
      controlsRef.current  = null;
      annoGroupRef.current = null;
      rendererRef.current  = null;
      exportSTLRef.current = null;
    };
  // Re-init when modules, cols, or rows change
  }, [modules, cols, rows]);

  // ── Drawing / annotation in 3D space ────────────────────────────────────
  useEffect(() => {
    const renderer  = rendererRef.current;
    const scene     = sceneRef.current;
    const camera    = cameraRef.current;
    const controls  = controlsRef.current;
    const annoGroup = annoGroupRef.current;
    if (!renderer || !scene || !camera || !controls || !annoGroup) return;

    controls.enabled = !isDrawingMode;
    renderer.domElement.style.cursor = isDrawingMode ? 'crosshair' : '';
    if (!isDrawingMode) return;

    const SNAP_RADIUS = 0.55; // meters — snap zone for endpoints
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.02);
    const raycaster   = new THREE.Raycaster();

    // Materials
    const annoMat = new THREE.MeshStandardMaterial({
      color: 0xff2222, roughness: 0.2, metalness: 0.0, emissive: 0xff2222, emissiveIntensity: 0.5,
    });
    const selMat = new THREE.MeshStandardMaterial({
      color: 0xffaa22, roughness: 0.2, metalness: 0.0, emissive: 0xffaa22, emissiveIntensity: 0.8,
    });

    // Yellow snap-point dot
    const snapDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0xffff00, emissiveIntensity: 1.0 }),
    );
    snapDot.visible = false;
    snapDot.position.y = 0.14;
    scene.add(snapDot);

    // ── Polygon fill detection ───────────────────────────────────────────
    const MERGE_D = SNAP_RADIUS * 0.75;
    const updateFills = () => {
      // Save existing fill colors keyed by sorted border-line UUIDs so we can restore them
      const savedColors = new Map<string, string>();
      const toRemove = annoGroup.children.filter(c => (c as THREE.Mesh).userData.isFill) as THREE.Mesh[];
      for (const m of toRemove) {
        const bl = m.userData.borderLines as THREE.Mesh[] | undefined;
        if (bl) {
          const key = bl.map(l => l.uuid).sort().join(',');
          savedColors.set(key, (m.userData.fillColorHex as string) ?? '#ffdd00');
        }
        annoGroup.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose();
      }

      const lines = annoGroup.children.filter(
        c => c !== previewMesh && !(c as THREE.Mesh).userData.isFill && (c as THREE.Mesh).userData.ptA,
      ) as THREE.Mesh[];
      if (lines.length < 3) return;

      const nodes: THREE.Vector3[] = [];
      const getNode = (pt: THREE.Vector3): number => {
        for (let i = 0; i < nodes.length; i++) if (nodes[i].distanceTo(pt) < MERGE_D) return i;
        nodes.push(pt.clone()); return nodes.length - 1;
      };
      const edges: [number, number][] = [];
      for (const line of lines) {
        const a = getNode(line.userData.ptA as THREE.Vector3);
        const b = getNode(line.userData.ptB as THREE.Vector3);
        if (a !== b) edges.push([a, b]);
      }

      const adj = new Map<number, number[]>();
      for (let i = 0; i < nodes.length; i++) adj.set(i, []);
      for (const [a, b] of edges) { adj.get(a)!.push(b); adj.get(b)!.push(a); }

      const visited = new Set<number>();
      const getComp = (start: number): number[] => {
        const comp: number[] = [], q = [start];
        while (q.length) {
          const n = q.pop()!;
          if (visited.has(n)) continue;
          visited.add(n); comp.push(n);
          for (const nb of (adj.get(n) ?? [])) if (!visited.has(nb)) q.push(nb);
        }
        return comp;
      };

      for (const startNode of adj.keys()) {
        if (visited.has(startNode)) continue;
        const comp = getComp(startNode);
        if (comp.length < 3) continue;
        if (!comp.every(n => (adj.get(n)?.length ?? 0) >= 2)) continue;
        const path: number[] = [comp[0]];
        let cur = comp[0], prev = -1, safety = 0;
        while (safety++ < 2000) {
          const nexts = (adj.get(cur) ?? []).filter(n => n !== prev);
          if (!nexts.length) break;
          const next = nexts[0];
          if (next === path[0] && path.length >= 3) {
            const compSet = new Set(comp);
            const borderLines = lines.filter(l => {
              const na = getNode(l.userData.ptA as THREE.Vector3);
              const nb = getNode(l.userData.ptB as THREE.Vector3);
              return compSet.has(na) && compSet.has(nb);
            });
            const colorKey = borderLines.map(l => l.uuid).sort().join(',');
            const savedHex = savedColors.get(colorKey) ?? '#ffdd00';
            const c = new THREE.Color(savedHex);
            const pts2d = path.map(i => new THREE.Vector2(nodes[i].x, nodes[i].z));
            const geo = new THREE.ShapeGeometry(new THREE.Shape(pts2d));
            geo.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
            const mat = new THREE.MeshStandardMaterial({
              color: c.clone(), transparent: true, opacity: 0.28,
              side: THREE.DoubleSide, depthWrite: false, roughness: 1.0, metalness: 0.0,
              emissive: c.clone(), emissiveIntensity: 0.12,
            });
            const fillMesh = new THREE.Mesh(geo, mat);
            fillMesh.position.y = 0.015;
            fillMesh.userData.isFill = true;
            fillMesh.userData.fillColorHex = savedHex;
            fillMesh.userData.borderLines = borderLines;
            annoGroup.add(fillMesh);
            break;
          }
          if (path.includes(next)) break;
          path.push(next); prev = cur; cur = next;
        }
      }
    };

    // ── Helpers ─────────────────────────────────────────────────────────
    const makeTube = (a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material = annoMat): THREE.Mesh => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const geo  = len > 0.001
        ? new THREE.CylinderGeometry(0.06, 0.06, len, 8)
        : new THREE.CylinderGeometry(0.06, 0.06, 0.001, 8);
      const mesh = new THREE.Mesh(geo, mat);
      if (len > 0.001) {
        mesh.position.copy(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      }
      mesh.userData.ptA = a.clone();
      mesh.userData.ptB = b.clone();
      return mesh;
    };

    const reshapeTube = (mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 0.001) return;
      mesh.geometry.dispose();
      mesh.geometry = new THREE.CylinderGeometry(0.06, 0.06, len, 8);
      mesh.position.copy(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.userData.ptA = a.clone();
      mesh.userData.ptB = b.clone();
    };

    const getGround = (ev: PointerEvent): THREE.Vector3 | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc  = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
        -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const pt = new THREE.Vector3();
      return raycaster.ray.intersectPlane(groundPlane, pt) ? pt : null;
    };

    const snapOrtho = (start: THREE.Vector3, cur: THREE.Vector3): THREE.Vector3 =>
      Math.abs(cur.x - start.x) >= Math.abs(cur.z - start.z)
        ? new THREE.Vector3(cur.x, 0.02, start.z)
        : new THREE.Vector3(start.x, 0.02, cur.z);

    // Find nearest line endpoint within SNAP_RADIUS, optionally skipping a mesh
    const findEndpoint = (pt: THREE.Vector3, skip?: THREE.Mesh): THREE.Vector3 | null => {
      let best: THREE.Vector3 | null = null;
      let bestDist = SNAP_RADIUS;
      for (const child of annoGroup.children) {
        if (child === skip || child === previewMesh || (child as THREE.Mesh).userData.isFill) continue;
        const m = child as THREE.Mesh;
        for (const key of ['ptA', 'ptB']) {
          const ep = m.userData[key] as THREE.Vector3 | undefined;
          if (!ep) continue;
          const d = pt.distanceTo(ep);
          if (d < bestDist) { bestDist = d; best = ep.clone(); }
        }
      }
      return best;
    };

    const showSnap = (pt: THREE.Vector3 | null) => {
      if (pt) { snapDot.position.set(pt.x, 0.14, pt.z); snapDot.visible = true; }
      else    { snapDot.visible = false; }
    };

    // ── State ────────────────────────────────────────────────────────────
    let selectedMesh:    THREE.Mesh | null = null;
    let previewMesh:     THREE.Mesh | null = null;
    let startPt:         THREE.Vector3 | null = null;
    let isDragging       = false;
    let isDraggingFill   = false;
    let dragGroundStart: THREE.Vector3 | null = null;
    let dragOrigA:       THREE.Vector3 | null = null;
    let dragOrigB:       THREE.Vector3 | null = null;
    let dragFillLines:   { mesh: THREE.Mesh; origA: THREE.Vector3; origB: THREE.Vector3 }[] = [];
    let dragFillMesh:    THREE.Mesh | null = null;
    let dragFillDownX    = 0;
    let dragFillDownY    = 0;

    const selectMesh = (m: THREE.Mesh) => {
      if (selectedMesh === m) return;
      deselect();
      selectedMesh = m;
      m.userData._prevMat = m.material;
      m.material = selMat.clone();
    };
    const deselect = () => {
      if (!selectedMesh) return;
      selectedMesh.material = (selectedMesh.userData._prevMat as THREE.Material) ?? annoMat;
      selectedMesh = null;
    };
    const syncSaved = () => {
      savedAnnotationsRef.current = annoGroup.children.filter(c => c !== previewMesh) as THREE.Mesh[];
    };

    // ── Event handlers ───────────────────────────────────────────────────
    const onDown = (ev: PointerEvent) => {
      ev.stopPropagation();
      renderer.domElement.setPointerCapture(ev.pointerId);
      const gpt = getGround(ev);

      // Raycast against committed line meshes
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width)  * 2 - 1,
        -((ev.clientY - rect.top)  / rect.height) * 2 + 1,
      ), camera);
      // Check fills first (they sit above lines at y=0.015)
      const fillHits = raycaster.intersectObjects(
        annoGroup.children.filter(c => (c as THREE.Mesh).userData.isFill), false,
      );
      if (fillHits.length > 0 && gpt) {
        const hitFill = fillHits[0].object as THREE.Mesh;
        const borderLines = hitFill.userData.borderLines as THREE.Mesh[] | undefined;
        if (borderLines && borderLines.length > 0) {
          deselect();
          isDraggingFill  = true;
          isDragging      = false;
          dragGroundStart = gpt;
          dragFillMesh    = hitFill;
          dragFillDownX   = ev.clientX;
          dragFillDownY   = ev.clientY;
          dragFillLines   = borderLines.map(m => ({
            mesh: m,
            origA: (m.userData.ptA as THREE.Vector3).clone(),
            origB: (m.userData.ptB as THREE.Vector3).clone(),
          }));
          return;
        }
      }

      const hits = raycaster.intersectObjects(
        annoGroup.children.filter(c => c !== previewMesh && !(c as THREE.Mesh).userData.isFill), false,
      );

      if (hits.length > 0) {
        // Click hit an existing line → select & prepare drag
        selectMesh(hits[0].object as THREE.Mesh);
        isDragging       = true;
        dragGroundStart  = gpt;
        dragOrigA        = (selectedMesh!.userData.ptA as THREE.Vector3).clone();
        dragOrigB        = (selectedMesh!.userData.ptB as THREE.Vector3).clone();
      } else {
        // Click on empty → deselect, start new line (snap start to endpoint)
        deselect();
        isDragging = false;
        if (gpt) {
          const snapped = findEndpoint(gpt);
          startPt = snapped ?? gpt;
          showSnap(snapped);
        }
      }
    };

    const onMove = (ev: PointerEvent) => {
      const gpt = getGround(ev);

      // ── Move entire polygon (fill drag) ──
      if (isDraggingFill && dragGroundStart && dragFillLines.length > 0) {
        if (!gpt) return;
        const delta = new THREE.Vector3().subVectors(gpt, dragGroundStart);
        for (const { mesh, origA, origB } of dragFillLines) {
          reshapeTube(mesh, origA.clone().add(delta), origB.clone().add(delta));
        }
        showSnap(null);
        updateFills();
        // updateFills recreated the fill mesh — keep dragFillMesh pointing to the new one
        if (dragFillLines.length > 0) {
          const origKey = dragFillLines.map(fl => fl.mesh.uuid).sort().join(',');
          const newFill = annoGroup.children.find(c => {
            const m = c as THREE.Mesh;
            if (!m.userData.isFill || !m.userData.borderLines) return false;
            return (m.userData.borderLines as THREE.Mesh[]).map(l => l.uuid).sort().join(',') === origKey;
          }) as THREE.Mesh | undefined;
          if (newFill) dragFillMesh = newFill;
        }
        return;
      }

      // ── Move selected line ──
      if (isDragging && selectedMesh && dragGroundStart && dragOrigA && dragOrigB) {
        if (!gpt) return;
        const delta = new THREE.Vector3().subVectors(gpt, dragGroundStart);
        const newA  = dragOrigA.clone().add(delta);
        const newB  = dragOrigB.clone().add(delta);
        // Snap the nearest of the two endpoints to any other line endpoint
        const sA = findEndpoint(newA, selectedMesh);
        const sB = findEndpoint(newB, selectedMesh);
        const dA = sA ? newA.distanceTo(sA) : Infinity;
        const dB = sB ? newB.distanceTo(sB) : Infinity;
        let finalA = newA, finalB = newB;
        if (sA && dA <= dB) {
          const shift = new THREE.Vector3().subVectors(sA, newA);
          finalA = sA; finalB = newB.clone().add(shift);
          showSnap(sA);
        } else if (sB) {
          const shift = new THREE.Vector3().subVectors(sB, newB);
          finalB = sB; finalA = newA.clone().add(shift);
          showSnap(sB);
        } else {
          showSnap(null);
        }
        reshapeTube(selectedMesh, finalA, finalB);
        updateFills();
        return;
      }

      // ── Preview new line ──
      if (!startPt || !gpt) { showSnap(null); return; }
      const rawEnd  = snapOrtho(startPt, gpt);
      const snapped = findEndpoint(rawEnd);
      const end     = snapped ?? rawEnd;
      showSnap(snapped);
      if (previewMesh) { annoGroup.remove(previewMesh); previewMesh.geometry.dispose(); }
      previewMesh = makeTube(startPt, end);
      (previewMesh.material as THREE.MeshStandardMaterial).transparent = true;
      (previewMesh.material as THREE.MeshStandardMaterial).opacity = 0.5;
      annoGroup.add(previewMesh);
    };

    const onUp = (ev: PointerEvent) => {
      showSnap(null);

      if (isDraggingFill) {
        const dx = ev.clientX - dragFillDownX;
        const dy = ev.clientY - dragFillDownY;
        const wasTap = Math.sqrt(dx * dx + dy * dy) < 6;
        if (wasTap && dragFillMesh) {
          onFillClickRef.current(dragFillMesh, ev.clientX, ev.clientY);
        } else {
          updateFills();
          syncSaved();
        }
        isDraggingFill  = false;
        dragGroundStart = null;
        dragFillLines   = [];
        dragFillMesh    = null;
        return;
      }

      if (isDragging) {
        isDragging = false;
        dragGroundStart = null;
        updateFills();
        syncSaved();
        return;
      }

      if (!startPt) return;
      const gpt = getGround(ev);
      if (gpt) {
        const rawEnd  = snapOrtho(startPt, gpt);
        const snapped = findEndpoint(rawEnd);
        const end     = snapped ?? rawEnd;
        if (previewMesh) { annoGroup.remove(previewMesh); previewMesh.geometry.dispose(); previewMesh = null; }
        if (startPt.distanceTo(end) > 0.05) {
          const solid = makeTube(startPt, end);
          annoGroup.add(solid);
          updateFills();
          onAnnotationAdded();
          syncSaved();
        }
      }
      startPt = null;
    };

    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup',   onUp);

    clearAnnotationsRef.current = () => {
      deselect();
      annoGroup.clear();
      savedAnnotationsRef.current = [];
      previewMesh = null;
      startPt     = null;
    };

    return () => {
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup',   onUp);
      if (previewMesh) { annoGroup.remove(previewMesh); previewMesh.geometry.dispose(); }
      scene.remove(snapDot);
      snapDot.geometry.dispose();
      (snapDot.material as THREE.Material).dispose();
      deselect();
      controls.enabled = true;
      renderer.domElement.style.cursor = '';
      clearAnnotationsRef.current = () => { annoGroup.clear(); savedAnnotationsRef.current = []; };
    };
  }, [isDrawingMode, clearAnnotationsRef, onAnnotationAdded, savedAnnotationsRef]);


  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function Home() {
  const [modules, setModules] = useState<PlacedModule[]>([]);
  const [drag,    setDrag]    = useState<DragState | null>(null);
  const [zoom,    setZoom]    = useState(1);
  const [view,    setView]    = useState<'2d' | '3d'>('2d');
  const [lightSettings, setLightSettings] = useState<LightSettings>({ isDay: true, sunAngle: 63, sunElevation: 53 });
  const [sceneSettings, setSceneSettings] = useState<SceneSettings>({ grass: 'dark', fogEnabled: true });
  const [cols,    setCols]    = useState(DEFAULT_COLS);

  const sunDirectionLabel = (angle: number): string => {
    const dirs = ['Sever', 'S-Istok', 'Istok', 'J-Istok', 'Jug', 'J-Zapad', 'Zapad', 'S-Zapad'];
    return dirs[Math.round(((angle % 360) + 360) % 360 / 45) % 8];
  };
  const [rows,    setRows]    = useState(DEFAULT_ROWS);
  const [genSmall, setGenSmall] = useState(2);
  const [genLarge, setGenLarge] = useState(4);
  const [genTall,  setGenTall]  = useState(0);

  // Objekti modal
  const [objektiModalOpen, setObjektiModalOpen] = useState(false);

  // Drawing / annotation tool
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [hasAnnotations, setHasAnnotations] = useState(false);
  const [fillPicker, setFillPicker] = useState<{ mesh: THREE.Mesh; x: number; y: number } | null>(null);
  const clearAnnotationsRef = useRef<(() => void) | null>(null);
  const exportSTLRef = useRef<(() => void) | null>(null);
  const savedCameraRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const savedAnnotationsRef = useRef<THREE.Mesh[]>([]);

  const FILL_COLORS = [
    { hex: '#ffdd00', label: 'Žuta' },
    { hex: '#ff4444', label: 'Crvena' },
    { hex: '#44aaff', label: 'Plava' },
    { hex: '#44dd88', label: 'Zelena' },
    { hex: '#cc44ff', label: 'Ljubičasta' },
    { hex: '#ff8833', label: 'Narandžasta' },
    { hex: '#ffffff', label: 'Bela' },
    { hex: '#333333', label: 'Tamna' },
  ];

  const applyFillColor = (hex: string) => {
    if (!fillPicker) return;
    const mesh = fillPicker.mesh;
    mesh.userData.fillColorHex = hex;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const c = new THREE.Color(hex);
    mat.color.copy(c);
    mat.emissive.copy(c);
    mat.needsUpdate = true;
    setFillPicker(null);
  };



  // Module options modal
  const [optionsModalOpen, setOptionsModalOpen] = useState(false);
  const [editingModuleId, setEditingModuleId] = useState<string | null>(null);

  // Preview 3D mini-scena u modalu
  const previewMountRef    = useRef<HTMLDivElement>(null);
  const previewRendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const previewAnimIdRef   = useRef<number>(0);
  const previewModelRef    = useRef<THREE.Object3D | null>(null);
  const previewSceneRef    = useRef<THREE.Scene | null>(null);

  const gridRef   = useRef<HTMLDivElement>(null);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const needsCenterRef = useRef(false);
  // Mutable ref so drag event handlers always see the latest zoom without stale closures
  const zoomRef   = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // Auto-expand grid when a module gets within GRID_MARGIN cells of an edge
  useEffect(() => {
    if (modules.length === 0) return;
    let newCols = cols;
    let newRows = rows;
    for (const m of modules) {
      const { w, h } = moduleSize(m);
      if (m.col + w >= cols - GRID_MARGIN) newCols = Math.max(newCols, m.col + w + GRID_MARGIN + GRID_EXPAND);
      if (m.row + h >= rows - GRID_MARGIN) newRows = Math.max(newRows, m.row + h + GRID_MARGIN + GRID_EXPAND);
    }
    if (newCols !== cols) setCols(newCols);
    if (newRows !== rows) setRows(newRows);
  }, [modules, cols, rows]);

  // ── PREVIEW 3D — inicijalizacija kad se modal otvori ──────────────────────
  useEffect(() => {
    if (!optionsModalOpen || !editingModuleId) return;
    const mount = previewMountRef.current;
    if (!mount) return;

    const editingMod = modules.find(m => m.id === editingModuleId);
    if (!editingMod) return;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0d14);
    previewSceneRef.current = scene;

    // Lights
    const hemi = new THREE.HemisphereLight(0x87ceeb, 0x334455, 1.4);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(6, 10, 8);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9bb4d0, 0.6);
    fill.position.set(-5, 4, -6);
    scene.add(fill);

    // Camera
    const w = mount.clientWidth;
    const h = mount.clientHeight;
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
    camera.position.set(5, 4, 6);
    camera.lookAt(0, 1, 0);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    mount.appendChild(renderer.domElement);
    previewRendererRef.current = renderer;

    // OrbitControls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotate = false;
    controls.target.set(0, 1, 0);
    controls.minDistance = 2;
    controls.maxDistance = 30;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.update();

    // Load GLB
    const loader = new GLTFLoader();
    loader.load(`/modules/${editingMod.glbFile}`, (gltf) => {
      const model = gltf.scene.clone();
      // Scale to fit nicely
      const bbox = new THREE.Box3().setFromObject(model);
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 3.5 / maxDim;
      model.scale.setScalar(scale);
      model.updateMatrixWorld(true);
      const bboxS = new THREE.Box3().setFromObject(model);
      const center = bboxS.getCenter(new THREE.Vector3());
      model.position.set(-center.x, -bboxS.min.y, -center.z);

      // Apply current visibility
      const applyVis = (mod: PlacedModule) => {
        const g = (name: string) => model.getObjectByName(name);
        if (g('konstrukcija')) g('konstrukcija')!.visible = mod.hasKonstrukcija;
        if (g('stakleni_krov')) g('stakleni_krov')!.visible = mod.hasStakleniKrov;
        if (g('fasada_2_pun_zid')) g('fasada_2_pun_zid')!.visible = mod.hasFasada2PunZid;
        if (g('fasada_1_sa_vratima')) g('fasada_1_sa_vratima')!.visible = mod.hasFasada1SaVratima;
        if (g('fasada_1_bez_vrata')) g('fasada_1_bez_vrata')!.visible = mod.hasFasada1BezVrata;
        if (g('fasada_4_podizno_klizniiiiiii')) g('fasada_4_podizno_klizniiiiiii')!.visible = mod.hasFasada4PodiznoKlizna;
        if (g('fasada_4_fix')) g('fasada_4_fix')!.visible = mod.hasFasada4Fix;
        if (g('fasada_4_kupatilo_prozor')) g('fasada_4_kupatilo_prozor')!.visible = mod.hasFasada4KupatiloProzor;
        if (g('fasada_3_prozor_spavaca')) g('fasada_3_prozor_spavaca')!.visible = mod.hasFasada3ProzorSpavaca;
        if (g('fasada_3_pun_zid')) g('fasada_3_pun_zid')!.visible = mod.hasFasada3PunZid;
        if (g('krov_pun')) g('krov_pun')!.visible = mod.hasKrovPun;
        if (g('fasada_4_pun_zid')) g('fasada_4_pun_zid')!.visible = mod.hasFasada4PunZid;
        if (g('fasada_1_podizno_klizniiiiiii')) g('fasada_1_podizno_klizniiiiiii')!.visible = mod.hasFasada1PodiznoKlizna;
        if (g('fasada_1_fix')) g('fasada_1_fix')!.visible = mod.hasFasada1Fix;
        if (g('fasada_2_podizno_klizniiiiiii')) g('fasada_2_podizno_klizniiiiiii')!.visible = mod.hasFasada2PodiznoKlizna;
        if (g('fasada_2_fix')) g('fasada_2_fix')!.visible = mod.hasFasada2Fix;
        if (g('fasada_3_podizno_klizniiiiiii')) g('fasada_3_podizno_klizniiiiiii')!.visible = mod.hasFasada3PodiznoKlizna;
        if (g('fasada_3_fix')) g('fasada_3_fix')!.visible = mod.hasFasada3Fix;
        if (g('fasada_1_pun_zid')) g('fasada_1_pun_zid')!.visible = mod.hasFasada1PunZid;
        if (g('fasada_1_sa_vratima_R')) g('fasada_1_sa_vratima_R')!.visible = mod.hasFasada1SaVratimaR;
        if (g('fasada_1_bez_vrata_R')) g('fasada_1_bez_vrata_R')!.visible = mod.hasFasada1BezVrataR;
        if (g('fasada_1_pun_zid_R')) g('fasada_1_pun_zid_R')!.visible = mod.hasFasada1PunZidR;
        if (g('fasada_3_prozor_spavaca_R')) g('fasada_3_prozor_spavaca_R')!.visible = mod.hasFasada3ProzorSpavacaR;
        if (g('fasada_3_pun_zid_R')) g('fasada_3_pun_zid_R')!.visible = mod.hasFasada3PunZidR;
        if (g('terasa_deck_otkrivena')) g('terasa_deck_otkrivena')!.visible = mod.hasTerasaDeckOtkrivena;
        if (g('terasa_velika_pergola')) g('terasa_velika_pergola')!.visible = mod.hasTerasaVelikaPergola;
        if (g('terasa_deck_mala')) g('terasa_deck_mala')!.visible = mod.hasTerasaDeckMala;
        if (g('mala_pergola_desna_gore')) g('mala_pergola_desna_gore')!.visible = mod.hasMalaPergolaDesnagore;
        if (g('mala_pergola_leva_gore')) g('mala_pergola_leva_gore')!.visible = mod.hasMalaPergolaLevaGore;
      };
      applyVis(editingMod);

      // Expose applyVis so the visibility-update effect can call it
      (model as any).__applyVis = applyVis;

      scene.add(model);
      previewModelRef.current = model;
    });

    // Render loop
    const animate = () => {
      previewAnimIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize
    const ro = new ResizeObserver(() => {
      const rw = mount.clientWidth;
      const rh = mount.clientHeight;
      camera.aspect = rw / rh;
      camera.updateProjectionMatrix();
      renderer.setSize(rw, rh);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(previewAnimIdRef.current);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      previewRendererRef.current = null;
      previewModelRef.current = null;
      previewSceneRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsModalOpen, editingModuleId]);

  // ── PREVIEW 3D — ažuriraj vidljivost kad se toggleovi menjaju ──────────────
  useEffect(() => {
    if (!optionsModalOpen || !editingModuleId) return;
    const model = previewModelRef.current;
    if (!model || !(model as any).__applyVis) return;
    const mod = modules.find(m => m.id === editingModuleId);
    if (mod) (model as any).__applyVis(mod);
  });

  const changeZoom = (delta: number) =>
    setZoom(prev => parseFloat(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prev + delta)).toFixed(2)));

  // ---- Add module ----
  const addModule = (type: ModuleType) => {
    const pos = firstFreePosition(type, 0, modules, cols, rows);
    if (!pos) return; // grid full
    
    // Odaberi GLB fajl na osnovu tipa
    const glbFile = type === 'large' ? 'large_full_modul.glb' : type === 'deck' ? 'large_full_large_deck.glb' : type === 'smalldeck' ? 'large_full_small_deck.glb' : type === 'medium' ? 'small_v2_full.glb' : 'small_full.glb';
    const isDeck = type === 'deck';
    const isSmallDeck = type === 'smalldeck';
    const isMedium = type === 'medium';
    const isSmall = type === 'small';
    const isLarge = type === 'large';
    
    setModules(prev => [
      ...prev,
      { 
        id: crypto.randomUUID(), 
        type, 
        glbFile,
        hasKonstrukcija: true,
        hasStakleniKrov: false,
        hasFasada2PunZid: false,
        hasFasada1SaVratima: false,
        hasFasada1BezVrata: false,
        hasFasada4PodiznoKlizna: false,
        hasFasada4Fix: false,
        hasFasada4KupatiloProzor: false,
        hasFasada3ProzorSpavaca: false,
        hasFasada3PunZid: false,
        hasKrovPun: false,
        hasFasada4PunZid: false,
        hasFasada1SaVratimaR: false,
        hasFasada1BezVrataR: false,
        hasFasada1PunZidR: false,
        hasFasada3ProzorSpavacaR: false,
        hasFasada3PunZidR: false,
        hasFasada1PodiznoKlizna: false,
        hasFasada1Fix: false,
        hasFasada2PodiznoKlizna: false,
        hasFasada2Fix: false,
        hasFasada3PodiznoKlizna: false,
        hasFasada3Fix: false,
        hasFasada1PunZid: false,
        hasTerasaDeckOtkrivena: false,
        hasTerasaVelikaPergola: false,
        hasTerasaDeckMala: false,
        hasMalaPergolaDesnagore: false,
        hasMalaPergolaLevaGore: false,
        col: pos.col, 
        row: pos.row, 
        rotation: 0 
      },
    ]);
  };

  // ---- Duplicate module ----
  const duplicateModule = (id: string) => {
    setModules(prev => {
      const src = prev.find(m => m.id === id);
      if (!src) return prev;
      const pos = firstFreePosition(src.type, src.rotation, prev, cols, rows);
      if (!pos) return prev;
      return [...prev, { ...src, id: crypto.randomUUID(), col: pos.col, row: pos.row }];
    });
  };

  // ---- Remove module ----
  const removeModule = (id: string) => {
    setModules(prev => prev.filter(m => m.id !== id));
  };

  // ---- Rotate module ----
  const rotateModule = (id: string) => {
    setModules(prev =>
      prev.map(m => {
        if (m.id !== id) return m;
        const rotation = ((m.rotation + 1) % 4) as 0 | 1 | 2 | 3;
        // 1x1 moduli (small, medium, deck, smalldeck) ostaju iste velicine bez obzira na rotaciju
        const is1x1 = m.type === 'small' || m.type === 'medium' || m.type === 'deck' || m.type === 'smalldeck';
        const newSize = is1x1 ? { w: 1, h: 1 } : (rotation % 2 !== 0 ? { w: 1, h: 2 } : { w: 2, h: 1 });
        const col      = Math.min(m.col, cols - newSize.w);
        const row      = Math.min(m.row, rows - newSize.h);
        const updated  = { ...m, rotation, col, row };
        const others   = prev.filter(o => o.id !== id);
        if (others.some(o => overlaps(updated, o))) return m;
        return updated;
      }),
    );
  };

  // ---- Toggle grupe iz large_full_modul.glb ----
  const toggleKonstrukcija = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasKonstrukcija: !m.hasKonstrukcija } : m));
  };
  const toggleStakleniKrov = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasStakleniKrov: !m.hasStakleniKrov } : m));
  };
  const toggleFasada2PunZid = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada2PunZid: !m.hasFasada2PunZid } : m));
  };
  const toggleFasada1SaVratima = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1SaVratima: !m.hasFasada1SaVratima } : m));
  };
  const toggleFasada1BezVrata = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1BezVrata: !m.hasFasada1BezVrata } : m));
  };
  const toggleFasada4PodiznoKlizna = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada4PodiznoKlizna: !m.hasFasada4PodiznoKlizna } : m));
  };
  const toggleFasada4Fix = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada4Fix: !m.hasFasada4Fix } : m));
  };
  const toggleFasada4KupatiloProzor = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada4KupatiloProzor: !m.hasFasada4KupatiloProzor } : m));
  };
  const toggleFasada3ProzorSpavaca = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada3ProzorSpavaca: !m.hasFasada3ProzorSpavaca } : m));
  };
  const toggleFasada3PunZid = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada3PunZid: !m.hasFasada3PunZid } : m));
  };
  const toggleKrovPun = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasKrovPun: !m.hasKrovPun } : m));
  };
  const toggleFasada4PunZid = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada4PunZid: !m.hasFasada4PunZid } : m));
  };
  // _R (desna strana) — samo large_full_modul.glb
  const toggleFasada1SaVratimaR = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1SaVratimaR: !m.hasFasada1SaVratimaR } : m));
  };
  const toggleFasada1BezVrataR = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1BezVrataR: !m.hasFasada1BezVrataR } : m));
  };
  const toggleFasada1PunZidR = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1PunZidR: !m.hasFasada1PunZidR } : m));
  };
  const toggleFasada3ProzorSpavacaR = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada3ProzorSpavacaR: !m.hasFasada3ProzorSpavacaR } : m));
  };
  const toggleFasada3PunZidR = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada3PunZidR: !m.hasFasada3PunZidR } : m));
  };

  // ---- Toggle grupe iz small_v2_full.glb (medium tip) ----
  const toggleFasada1PodiznoKlizna = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1PodiznoKlizna: !m.hasFasada1PodiznoKlizna } : m));
  };
  const toggleFasada1Fix = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1Fix: !m.hasFasada1Fix } : m));
  };
  const toggleFasada2PodiznoKlizna = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada2PodiznoKlizna: !m.hasFasada2PodiznoKlizna } : m));
  };
  const toggleFasada2Fix = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada2Fix: !m.hasFasada2Fix } : m));
  };
  const toggleFasada3PodiznoKlizna = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada3PodiznoKlizna: !m.hasFasada3PodiznoKlizna } : m));
  };
  const toggleFasada3Fix = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada3Fix: !m.hasFasada3Fix } : m));
  };
  const toggleFasada1PunZid = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasFasada1PunZid: !m.hasFasada1PunZid } : m));
  };

  // ---- Toggle grupe iz large_full_large_deck.glb (deck tip) ----
  const toggleTerasaDeckOtkrivena = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasTerasaDeckOtkrivena: !m.hasTerasaDeckOtkrivena } : m));
  };
  const toggleTerasaVelikaPergola = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasTerasaVelikaPergola: !m.hasTerasaVelikaPergola } : m));
  };

  // ---- Toggle grupe iz large_full_small_deck.glb (smalldeck tip) ----
  const toggleTerasaDeckMala = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasTerasaDeckMala: !m.hasTerasaDeckMala } : m));
  };
  const toggleMalaPergolaDesnagore = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasMalaPergolaDesnagore: !m.hasMalaPergolaDesnagore } : m));
  };
  const toggleMalaPergolaLevaGore = (id: string) => {
    setModules(prev => prev.map(m => m.id === id ? { ...m, hasMalaPergolaLevaGore: !m.hasMalaPergolaLevaGore } : m));
  };

  // Open options modal
  const openOptionsModal = (id: string) => {
    setEditingModuleId(id);
    setOptionsModalOpen(true);
  };

  // ---- Generate layout ----
  const handleGenerate = () => {
    if (genSmall === 0 && genLarge === 0 && genTall === 0) return;
    needsCenterRef.current = true;
    setModules(generateLayout(genSmall, genLarge, genTall, cols, rows));
  };

  // ---- Save layout ----
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSaveLayout = async () => {
    if (modules.length === 0) return;
    setSaveStatus('saving');
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSaveStatus('error'); return; }
    const area = modules.reduce((sum, m) => {
      const { w, h } = moduleSize(m);
      return sum + w * 2.4 * h * 2.4;
    }, 0);
    const { error } = await supabase.from('layouts').insert({
      user_id: user.id,
      layout: modules,
      large_count: 0,
      small_count: 0,
      tall_count:  null,
      total_area_m2: parseFloat(area.toFixed(2)),
    });
    if (error) { setSaveStatus('error'); setTimeout(() => setSaveStatus('idle'), 3000); }
    else { setSaveStatus('saved'); setTimeout(() => setSaveStatus('idle'), 2500); }
  };

  // ---- Logout ----
  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/login';
  };

  const clearAnnotations = () => {
    clearAnnotationsRef.current?.();
    setHasAnnotations(false);
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
      
      // Color scheme based on module type and components visibility
      let svgFill: string;
      let svgStroke: string;
      let svgLabel: string;
      if (m.type === 'medium' || m.type === 'small') {
        const activeCount = [m.hasKonstrukcija, m.hasStakleniKrov, m.hasFasada2PunZid, m.hasFasada3PunZid, m.hasFasada4PunZid, m.hasFasada4PodiznoKlizna, m.hasFasada4Fix, m.hasKrovPun, m.hasFasada1PodiznoKlizna, m.hasFasada1Fix, m.hasFasada2PodiznoKlizna, m.hasFasada2Fix, m.hasFasada3PodiznoKlizna, m.hasFasada3Fix, m.hasFasada1PunZid].filter(Boolean).length;
        svgLabel = activeCount === 0 ? 'PRAZAN' : activeCount === 15 ? 'KOMPLETAN' : `${activeCount}/15`;
        svgFill = m.type === 'medium' ? '#f97316' : '#3b82f6';
        svgStroke = m.type === 'medium' ? '#ea580c' : '#2563eb';
      } else if (m.type === 'deck') {
        const activeCount = [m.hasTerasaDeckOtkrivena, m.hasTerasaVelikaPergola].filter(Boolean).length;
        svgLabel = activeCount === 0 ? 'PRAZAN' : activeCount === 2 ? 'KOMPLETAN' : `${activeCount}/2`;
        svgFill = '#14b8a6';
        svgStroke = '#0d9488';
      } else if (m.type === 'smalldeck') {
        const activeCount = [m.hasTerasaDeckMala, m.hasMalaPergolaDesnagore, m.hasMalaPergolaLevaGore].filter(Boolean).length;
        svgLabel = activeCount === 0 ? 'PRAZAN' : activeCount === 3 ? 'KOMPLETAN' : `${activeCount}/3`;
        svgFill = '#06b6d4';
        svgStroke = '#0891b2';
      } else {
        const activeCount = [m.hasKonstrukcija, m.hasStakleniKrov, m.hasFasada2PunZid, m.hasFasada1SaVratima, m.hasFasada1BezVrata, m.hasFasada4PodiznoKlizna, m.hasFasada4Fix, m.hasFasada4KupatiloProzor, m.hasFasada3ProzorSpavaca, m.hasFasada3PunZid, m.hasKrovPun, m.hasFasada4PunZid, m.hasFasada1SaVratimaR, m.hasFasada1BezVrataR, m.hasFasada1PunZidR, m.hasFasada3ProzorSpavacaR, m.hasFasada3PunZidR].filter(Boolean).length;
        svgLabel = activeCount === 0 ? 'PRAZAN' : activeCount === 17 ? 'KOMPLETAN' : `${activeCount}/17`;
        svgFill = '#22c55e'; 
        svgStroke = '#16a34a';
      }
      const colors = { fill: svgFill, stroke: svgStroke, label: svgLabel };
      
      const tc      = '#ffffff';
      const tc2     = 'rgba(255,255,255,0.65)';
      const size    = m.type === 'large' ? (w === 2 ? '4.8 × 2.4 m' : '2.4 × 4.8 m') : '2.4 × 2.4 m';
      const numX    = x + w * SCALE - 10;
      const numY    = y + 14;
      const cx      = x + w * SCALE / 2;
      const cy      = y + h * SCALE / 2;
      return [
        `<rect x="${x+2}" y="${y+2}" width="${w*SCALE-4}" height="${h*SCALE-4}" rx="8" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1"/>`,
        `<text x="${numX}" y="${numY}" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" font-weight="500" fill="${tc2}" text-anchor="end">${idx + 1}</text>`,
        `<text x="${cx}" y="${cy - 6}" font-family="'Inter','Helvetica Neue',sans-serif" font-size="10" font-weight="700" fill="${tc}" text-anchor="middle" letter-spacing="0.06em">${colors.label}</text>`,
        `<text x="${cx}" y="${cy + 10}" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="${tc2}" text-anchor="middle">${size}</text>`,
      ].join('');
    }).join('');
    // legend
    const legend = `<g transform="translate(${PAD},${svgH - 18})">
      <rect x="0" y="-7" width="10" height="10" rx="2" fill="#6366f1"/>
      <text x="14" y="1" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="#9098a8">Custom</text>
      <rect x="80" y="-7" width="10" height="10" rx="2" fill="#22c55e"/>
      <text x="94" y="1" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="#9098a8">Empty</text>
      <rect x="150" y="-7" width="10" height="10" rx="2" fill="#fb923c"/>
      <text x="164" y="1" font-family="'Inter','Helvetica Neue',sans-serif" font-size="8" fill="#9098a8">Full Roof</text>
    </g>`;
    const bboxW = bbox ? bbox.w.toFixed(1) : '—';
    const bboxH = bbox ? bbox.h.toFixed(1) : '—';
    const date  = new Date().toLocaleDateString('sr-Latn-RS', { year: 'numeric', month: 'long', day: 'numeric' });
    const refNo = `MH-GLB-${new Date().getFullYear()}-${String(modules.length).padStart(3,'0')}`;
    const totalAreaVal = totalArea.toFixed(2);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Modular Houses – GLB Layout</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@page{margin:0}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter','Helvetica Neue',Arial,sans-serif;background:#f2f4f7;color:#1a1a2e;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{background:#fff;max-width:860px;margin:0 auto;min-height:100vh}
/* ── HEADER BAND ── */
.header-band{background:#000000;padding:28px 52px;display:flex;align-items:center;justify-content:space-between}
.header-band img{height:34px;filter:brightness(0) invert(1)}
.header-right{text-align:right}
.header-ref{font-size:9px;letter-spacing:.12em;color:#ffffff;text-transform:uppercase;font-weight:600;margin-bottom:4px}
.header-date{font-size:13px;color:#ffffff;font-weight:700}
.header-email{font-size:11px;color:#ffffff;margin-top:3px}
/* ── BODY ── */
.body{padding:44px 52px 52px}
/* ── TITLE ROW ── */
.title-row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #f0f2f5}
.doc-title{font-size:22px;font-weight:700;color:#000000;letter-spacing:-.02em}
.doc-sub{font-size:12px;color:#9098a8;font-weight:500;margin-top:4px}
.badge{background:#000000;color:#ffffff;font-size:10px;font-weight:700;letter-spacing:.06em;padding:5px 10px;border-radius:6px;border:1px solid #333333}
/* ── STATS ── */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:36px}
.stat{background:#f8f9fb;border:1px solid #eaecf0;border-radius:10px;padding:16px 14px;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:#000000;border-radius:10px 10px 0 0}
.stat-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#9098a8;font-weight:600;margin-bottom:8px}
.stat-value{font-size:18px;font-weight:700;color:#000000;line-height:1}
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
    <div class="stat"><div class="stat-label">Ukupno modula</div><div class="stat-value">${modules.length}<span class="stat-unit">mod.</span></div></div>
    <div class="stat"><div class="stat-label">Sa konstrukcijom</div><div class="stat-value">${modules.filter(m => m.hasKonstrukcija).length}<span class="stat-unit">mod.</span></div></div>
    <div class="stat"><div class="stat-label">Sa krovom pun</div><div class="stat-value">${modules.filter(m => m.hasKrovPun).length}<span class="stat-unit">mod.</span></div></div>
    <div class="stat"><div class="stat-label">Sa staklenim krovom</div><div class="stat-value">${modules.filter(m => m.hasStakleniKrov).length}<span class="stat-unit">mod.</span></div></div>
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

  // ---- Touch drag start ----
  const handleTouchStart = useCallback(
    (e: React.TouchEvent, id: string) => {
      e.preventDefault();
      const touch = e.touches[0];
      const m = modules.find(m => m.id === id);
      if (!m || !gridRef.current) return;
      const rect    = gridRef.current.getBoundingClientRect();
      const z       = zoomRef.current;
      const offsetX = (touch.clientX - rect.left) / z - m.col * CELL;
      const offsetY = (touch.clientY - rect.top)  / z - m.row * CELL;
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
        const valid     = inBounds(candidate, cols, rows) && !others.some(o => overlaps(candidate, o));
        if (valid) {
          setModules(prev =>
            prev.map(mod => (mod.id === drag.id ? { ...mod, col: drag.ghostCol, row: drag.ghostRow } : mod)),
          );
        }
      }
      setDrag(null);
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      const z    = zoomRef.current;
      const rawX = (touch.clientX - rect.left) / z - drag.offsetX;
      const rawY = (touch.clientY - rect.top)  / z - drag.offsetY;
      const snap = (v: number) => Math.round(v / CELL * 2) / 2;
      setDrag(d =>
        d ? { ...d, ghostCol: snap(rawX), ghostRow: snap(rawY) } : null,
      );
    };

    const onTouchEnd = () => onUp();

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    window.addEventListener('touchmove',  onTouchMove, { passive: false });
    window.addEventListener('touchend',   onTouchEnd);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
      window.removeEventListener('touchmove',  onTouchMove);
      window.removeEventListener('touchend',   onTouchEnd);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, modules]);

  // ---- Ghost validity ----
  const draggingModule = drag ? modules.find(m => m.id === drag.id) : null;
  const ghostValid = draggingModule
    ? (() => {
        const candidate = { ...draggingModule, col: drag!.ghostCol, row: drag!.ghostRow };
        const others    = modules.filter(o => o.id !== drag!.id);
        return inBounds(candidate, cols, rows) && !others.some(o => overlaps(candidate, o));
      })()
    : false;

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
      <style>{`
        @keyframes overlay-in { from { opacity: 0 } to { opacity: 1 } }
        @keyframes card-in { from { opacity: 0; transform: translate(-50%,-50%) scale(0.92) } to { opacity: 1; transform: translate(-50%,-50%) scale(1) } }
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes check-in { from { opacity:0; transform:scale(0.5) } to { opacity:1; transform:scale(1) } }
      `}</style>

      {/* ── Save overlay ── */}
      {(saveStatus === 'saving' || saveStatus === 'saved') && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
          animation: 'overlay-in 0.18s ease',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)',
            background: '#141418', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 20, padding: '36px 48px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
            animation: 'card-in 0.22s cubic-bezier(0.34,1.56,0.64,1)',
            minWidth: 240,
          }}>
            {saveStatus === 'saving' ? (
              <>
                <div style={{
                  width: 44, height: 44,
                  border: '3px solid rgba(255,255,255,0.08)',
                  borderTop: '3px solid rgba(255,255,255,0.7)',
                  borderRadius: '50%',
                  animation: 'spin 0.7s linear infinite',
                }}/>
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, margin: 0 }}>Čuvam raspored...</p>
              </>
            ) : (
              <>
                <div style={{
                  width: 52, height: 52, borderRadius: '50%',
                  background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.35)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  animation: 'check-in 0.25s cubic-bezier(0.34,1.56,0.64,1)',
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgb(134,239,172)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ color: '#fff', fontSize: 15, fontWeight: 600, margin: '0 0 4px' }}>Raspored sačuvan</p>
                  <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, margin: 0 }}>Uspešno dodat u bazu</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <header className="tablet-ui" style={{
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

          {/* Add modules */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => addModule('large')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.35)',
                borderRadius: 8, padding: '6px 11px',
                color: 'rgba(134,239,172,0.95)', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(34,197,94,0.25)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(34,197,94,0.15)';
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(134,239,172,0.95)';
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(134,239,172,0.6)', marginBottom: 1 }}>+</span>
              <span>Veliki Modul</span>
            </button>

            <button
              onClick={() => addModule('small')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.35)',
                borderRadius: 8, padding: '6px 11px',
                color: 'rgba(147,197,253,0.95)', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.25)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.15)';
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(147,197,253,0.95)';
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(147,197,253,0.6)', marginBottom: 1 }}>+</span>
              <span>Mali Modul</span>
            </button>

            <button
              onClick={() => addModule('medium')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.35)',
                borderRadius: 8, padding: '6px 11px',
                color: 'rgba(253,186,116,0.95)', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(249,115,22,0.25)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(249,115,22,0.15)';
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(253,186,116,0.95)';
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(253,186,116,0.6)', marginBottom: 1 }}>+</span>
              <span>Visoki modul</span>
            </button>

            <button
              onClick={() => addModule('deck')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(20,184,166,0.15)', border: '1px solid rgba(20,184,166,0.35)',
                borderRadius: 8, padding: '6px 11px',
                color: 'rgba(94,234,212,0.95)', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(20,184,166,0.25)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(20,184,166,0.15)';
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(94,234,212,0.95)';
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(94,234,212,0.6)', marginBottom: 1 }}>+</span>
              <span>Velika Terasa</span>
            </button>

            <button
              onClick={() => addModule('smalldeck')}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'rgba(6,182,212,0.15)', border: '1px solid rgba(6,182,212,0.35)',
                borderRadius: 8, padding: '6px 11px',
                color: 'rgba(103,232,249,0.95)', cursor: 'pointer',
                fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(6,182,212,0.25)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(6,182,212,0.15)';
                (e.currentTarget as HTMLButtonElement).style.color = 'rgba(103,232,249,0.95)';
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1, fontWeight: 200, color: 'rgba(103,232,249,0.6)', marginBottom: 1 }}>+</span>
              <span>Mala Terasa</span>
            </button>
          </div>
        </div>

        {/* Hidden generator controls - keep for backward compatibility */}
        <div style={{ display: 'none' }}>
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

          {/* Visoki stepper */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: '#dc2626', whiteSpace: 'nowrap' }}>Visoki</span>
            <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden' }}>
              <button
                onClick={() => setGenTall(s => Math.max(0, s - 1))}
                style={{ width: 32, height: 32, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18, fontWeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.1s, color 0.1s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)'; }}
              >−</button>
              <span style={{ width: 36, textAlign: 'center', fontSize: 15, fontWeight: 700, color: 'rgba(255,255,255,0.9)', fontVariantNumeric: 'tabular-nums', userSelect: 'none' }}>{genTall}</span>
              <button
                onClick={() => setGenTall(s => Math.min(20, s + 1))}
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
            disabled={genSmall === 0 && genLarge === 0 && genTall === 0}
            style={{
              background: genSmall === 0 && genLarge === 0 && genTall === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.13)',
              borderRadius: 8, padding: '0 16px', height: 32,
              color: genSmall === 0 && genLarge === 0 && genTall === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.82)',
              cursor: genSmall === 0 && genLarge === 0 && genTall === 0 ? 'not-allowed' : 'pointer',
              fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
              transition: 'all 0.12s',
            }}
            onMouseEnter={e => {
              if (genSmall > 0 || genLarge > 0 || genTall > 0) {
                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.18)';
                (e.currentTarget as HTMLButtonElement).style.color = '#fff';
              }
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = genSmall === 0 && genLarge === 0 && genTall === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.1)';
              (e.currentTarget as HTMLButtonElement).style.color = genSmall === 0 && genLarge === 0 && genTall === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.82)';
            }}
          >
            Generiši
          </button>
        </div>

        {/* ── Right: Export + Delete + Zoom + 2D/3D ── */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {modules.length > 0 && (
            <button
              onClick={handleSaveLayout}
              disabled={saveStatus === 'saving'}
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '6px 13px',
                color: saveStatus === 'error' ? '#f87171' : 'rgba(255,255,255,0.6)',
                cursor: saveStatus === 'saving' ? 'wait' : 'pointer',
                fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap',
                transition: 'all 0.12s', display: 'flex', alignItems: 'center', gap: 5,
              }}
              onMouseEnter={e => { if (saveStatus === 'idle') { e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; e.currentTarget.style.color = '#fff'; } }}
              onMouseLeave={e => { if (saveStatus === 'idle') { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; } }}
            >
              {saveStatus === 'error' ? 'Greška' : 'Sačuvaj'}
            </button>
          )}

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

          {modules.length > 0 && view === '3d' && (
            <button
              onClick={() => exportSTLRef.current?.()}
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
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z" fill="none"/>
                <path d="M4 2h8v2H4zM3 4h10l-1 7H4L3 4zM6 8h4M6 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              STL
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

          {/* Logout */}
          <button
            onClick={handleLogout}
            title=""
            style={{
              height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              borderRadius: 8, border: '1px solid rgba(220,50,50,0.35)',
              background: 'rgba(200,30,30,0.15)', color: 'rgba(255,100,100,0.85)',
              cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '0 8px',
              transition: 'all 0.12s', letterSpacing: '0.02em',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(200,30,30,0.28)'; e.currentTarget.style.color = '#ff6b6b'; e.currentTarget.style.borderColor = 'rgba(220,50,50,0.6)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(200,30,30,0.15)'; e.currentTarget.style.color = 'rgba(255,100,100,0.85)'; e.currentTarget.style.borderColor = 'rgba(220,50,50,0.35)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── Stats bar ────────────────────────────────────────────── */}
      <div className="tablet-ui" style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: '#0a0a0d',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        height: 40,
        flexShrink: 0,
        fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
      }}>
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
        {/* Screenshot dugme — vidljivo samo u 3D */}
        {view === '3d' && (
          <>
            <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.07)', margin: '0 22px' }} />
            <button
              onClick={() => setObjektiModalOpen(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)',
                borderRadius: 7, padding: '0 12px', height: 26, cursor: 'pointer',
                color: 'rgba(180,180,255,0.9)', fontSize: 12, fontWeight: 600,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.28)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.15)'; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
              Objekti
            </button>
            <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.07)', margin: '0 10px 0 0' }} />
            <button
              onClick={() => { const r = (document.querySelector('canvas') as HTMLCanvasElement); if (!r) return; const a = document.createElement('a'); a.href = r.toDataURL('image/png'); a.download = `modular-${Date.now()}.png`; a.click(); }}
              title="Snimi sliku"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 7, padding: '0 10px', height: 26, cursor: 'pointer',
                color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 600,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
              Snimi
            </button>

            {/* ── Pencil / annotation tool ── */}
            <button
              onClick={() => setIsDrawingMode(p => !p)}
              title={isDrawingMode ? 'Izađi iz načina crtanja' : 'Označi na 3D prikazu'}
              style={{
                marginLeft: 6,
                display: 'flex', alignItems: 'center', gap: 6,
                background: isDrawingMode ? 'rgba(239,68,68,0.22)' : 'rgba(255,255,255,0.07)',
                border: `1px solid ${isDrawingMode ? 'rgba(239,68,68,0.55)' : 'rgba(255,255,255,0.12)'}`,
                borderRadius: 7, padding: '0 10px', height: 26, cursor: 'pointer',
                color: isDrawingMode ? '#f87171' : 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: 600,
                transition: 'all 0.15s',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9"/>
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
              {isDrawingMode ? 'Zatvori' : 'Označi'}
            </button>
            {(isDrawingMode || hasAnnotations) && (
              <button
                onClick={clearAnnotations}
                title="Obriši sve oznake"
                style={{
                  marginLeft: 4,
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 7, padding: '0 9px', height: 26, cursor: 'pointer',
                  color: 'rgba(255,255,255,0.35)', fontSize: 12, fontWeight: 600,
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#f87171'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.3)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.35)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.08)'; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                </svg>
                Obriši oznake
              </button>
            )}

          </>
        )}
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
        <div style={{ width: cols * CELL * zoom, height: rows * CELL * zoom, position: 'relative', flexShrink: 0 }}>
          {/* Actual grid — scaled from top-left */}
          <div
            ref={gridRef}
            style={{
              position:        'absolute',
              top:             0,
              left:            0,
              transformOrigin: 'top left',
              transform:       `scale(${zoom})`,
              width:           cols * CELL,
              height:          rows * CELL,
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
            const isBeingDragged = drag?.id === m.id;
            
            // Color scheme - različite boje za large i small module
            const colors = m.type === 'large' ? {
              bg: 'linear-gradient(135deg, rgba(34,197,94,0.2) 0%, rgba(74,222,128,0.2) 100%)',
              border: 'rgba(34,197,94,0.4)',
              shadow: 'rgba(34,197,94,0.25)',
              arrow: 'rgba(34,197,94,0.6)',
              btnBg: 'rgba(34,197,94,0.2)',
              btnBorder: 'rgba(34,197,94,0.3)',
              btnHover: 'rgba(34,197,94,0.35)',
              text: 'rgba(134,239,172,0.95)',
              textSub: 'rgba(134,239,172,0.8)',
              label: (() => {
                const activeCount = [
                  m.hasKonstrukcija, m.hasStakleniKrov, m.hasFasada2PunZid, m.hasFasada1SaVratima,
                  m.hasFasada1BezVrata, m.hasFasada4PodiznoKlizna, m.hasFasada4Fix, m.hasFasada4KupatiloProzor,
                  m.hasFasada3ProzorSpavaca, m.hasFasada3PunZid, m.hasKrovPun, m.hasFasada4PunZid,
                ].filter(Boolean).length;
                return activeCount === 0 ? 'PRAZAN' : activeCount === 12 ? 'KOMPLETAN' : `${activeCount}/12`;
              })()
            } : m.type === 'medium' ? {
              // Medium modul - narandzasta boja
              bg: 'linear-gradient(135deg, rgba(249,115,22,0.2) 0%, rgba(251,146,60,0.2) 100%)',
              border: 'rgba(249,115,22,0.4)',
              shadow: 'rgba(249,115,22,0.25)',
              arrow: 'rgba(249,115,22,0.6)',
              btnBg: 'rgba(249,115,22,0.2)',
              btnBorder: 'rgba(249,115,22,0.3)',
              btnHover: 'rgba(249,115,22,0.35)',
              text: 'rgba(253,186,116,0.95)',
              textSub: 'rgba(253,186,116,0.8)',
              label: (() => {
                const activeCount = [
                  m.hasKonstrukcija, m.hasStakleniKrov, m.hasFasada2PunZid, m.hasFasada3PunZid,
                  m.hasFasada4PunZid, m.hasFasada4PodiznoKlizna, m.hasFasada4Fix, m.hasKrovPun,
                  m.hasFasada1PodiznoKlizna, m.hasFasada1Fix, m.hasFasada2PodiznoKlizna, m.hasFasada2Fix,
                  m.hasFasada3PodiznoKlizna, m.hasFasada3Fix, m.hasFasada1PunZid,
                ].filter(Boolean).length;
                return activeCount === 0 ? 'PRAZAN' : activeCount === 15 ? 'KOMPLETAN' : `${activeCount}/15`;
              })()
            } : m.type === 'deck' ? {
              // Deck modul - teal boja
              bg: 'linear-gradient(135deg, rgba(20,184,166,0.2) 0%, rgba(45,212,191,0.2) 100%)',
              border: 'rgba(20,184,166,0.4)',
              shadow: 'rgba(20,184,166,0.25)',
              arrow: 'rgba(20,184,166,0.6)',
              btnBg: 'rgba(20,184,166,0.2)',
              btnBorder: 'rgba(20,184,166,0.3)',
              btnHover: 'rgba(20,184,166,0.35)',
              text: 'rgba(94,234,212,0.95)',
              textSub: 'rgba(94,234,212,0.8)',
              label: (() => {
                const activeCount = [m.hasTerasaDeckOtkrivena, m.hasTerasaVelikaPergola].filter(Boolean).length;
                return activeCount === 0 ? 'PRAZAN' : activeCount === 2 ? 'KOMPLETAN' : `${activeCount}/2`;
              })()
            } : m.type === 'smalldeck' ? {
              // SmallDeck modul - cyan boja
              bg: 'linear-gradient(135deg, rgba(6,182,212,0.2) 0%, rgba(34,211,238,0.2) 100%)',
              border: 'rgba(6,182,212,0.4)',
              shadow: 'rgba(6,182,212,0.25)',
              arrow: 'rgba(6,182,212,0.6)',
              btnBg: 'rgba(6,182,212,0.2)',
              btnBorder: 'rgba(6,182,212,0.3)',
              btnHover: 'rgba(6,182,212,0.35)',
              text: 'rgba(103,232,249,0.95)',
              textSub: 'rgba(103,232,249,0.8)',
              label: (() => {
                const activeCount = [m.hasTerasaDeckMala, m.hasMalaPergolaDesnagore, m.hasMalaPergolaLevaGore].filter(Boolean).length;
                return activeCount === 0 ? 'PRAZAN' : activeCount === 3 ? 'KOMPLETAN' : `${activeCount}/3`;
              })()
            } : {
              // Small modul - plava boja
              bg: 'linear-gradient(135deg, rgba(59,130,246,0.2) 0%, rgba(96,165,250,0.2) 100%)',
              border: 'rgba(59,130,246,0.4)',
              shadow: 'rgba(59,130,246,0.25)',
              arrow: 'rgba(59,130,246,0.6)',
              btnBg: 'rgba(59,130,246,0.2)',
              btnBorder: 'rgba(59,130,246,0.3)',
              btnHover: 'rgba(59,130,246,0.35)',
              text: 'rgba(147,197,253,0.95)',
              textSub: 'rgba(147,197,253,0.8)',
              label: (() => {
                const activeCount = [
                  m.hasKonstrukcija, m.hasStakleniKrov, m.hasFasada2PunZid, m.hasFasada3PunZid,
                  m.hasFasada4PunZid, m.hasFasada4PodiznoKlizna, m.hasFasada4Fix, m.hasKrovPun,
                  m.hasFasada1PodiznoKlizna, m.hasFasada1Fix, m.hasFasada2PodiznoKlizna, m.hasFasada2Fix,
                  m.hasFasada3PodiznoKlizna, m.hasFasada3Fix, m.hasFasada1PunZid,
                ].filter(Boolean).length;
                return activeCount === 0 ? 'PRAZAN' : activeCount === 15 ? 'KOMPLETAN' : `${activeCount}/15`;
              })()
            };

            return (
              <div
                key={m.id}
                onMouseDown={e => handleMouseDown(e, m.id)}
                onTouchStart={e => handleTouchStart(e, m.id)}
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
                    background:    colors.bg,
                    border:        `2px solid ${colors.border}`,
                    position:      'relative',
                    overflow:      'hidden',
                    boxShadow:     `0 4px 24px ${colors.shadow}`,
                  }}
                >
                  {/* Rotation indicator - samo za large module */}
                  {m.type === 'large' && (() => {
                    const r = m.rotation;
                    return (
                      <>
                        {r === 0 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 14, color: colors.arrow, left: 14, top: '50%', transform: 'translateY(-50%)' }}>→</span>}
                        {r === 1 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 14, color: colors.arrow, top: 14, left: '50%', transform: 'translateX(-50%)' }}>↓</span>}
                        {r === 2 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 14, color: colors.arrow, right: 14, top: '50%', transform: 'translateY(-50%)' }}>←</span>}
                        {r === 3 && <span style={{ position: 'absolute', pointerEvents: 'none', zIndex: 1, fontSize: 14, color: colors.arrow, bottom: 14, left: '50%', transform: 'translateX(-50%)' }}>↑</span>}
                      </>
                    );
                  })()}

                  {/* Action buttons — top-right corner */}
                  <div style={{
                    position: 'absolute', top: 14, right: 14,
                    display: 'flex', flexDirection: 'column', gap: 4, zIndex: 1, alignItems: 'flex-end',
                  }}>
                    {/* Row 1: Rotate, Settings, X */}
                    <div style={{ display: 'flex', gap: 4 }}>
                    {/* Rotate button - za large, deck i smalldeck module */}
                    {(m.type === 'large' || m.type === 'deck' || m.type === 'smalldeck') && (
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); rotateModule(m.id); }}
                        title="Rotiraj"
                        style={{
                          width: 22, height: 22, borderRadius: '50%',
                          background: colors.btnBg,
                          border: `1px solid ${colors.btnBorder}`, cursor: 'pointer', color: colors.text,
                          fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'background 0.15s', flexShrink: 0,
                        }}
                        onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnHover)}
                        onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnBg)}
                      >↻</button>
                    )}
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); openOptionsModal(m.id); }}
                      title="Opcije modula"
                      style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: colors.btnBg,
                        border: `1px solid ${colors.btnBorder}`, cursor: 'pointer', color: colors.text,
                        fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s', flexShrink: 0,
                      }}
                      onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnHover)}
                      onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnBg)}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    </button>
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); removeModule(m.id); }}
                      title="Ukloni"
                      style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: colors.btnBg,
                        border: `1px solid ${colors.btnBorder}`, cursor: 'pointer', color: colors.text,
                        fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s', flexShrink: 0,
                      }}
                      onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.5)')}
                      onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnBg)}
                    >✕</button>
                    </div>
                    {/* Row 2: Duplicate */}
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); duplicateModule(m.id); }}
                      title="Dupliraj"
                      style={{
                        width: 22, height: 22, borderRadius: '50%',
                        background: colors.btnBg,
                        border: `1px solid ${colors.btnBorder}`, cursor: 'pointer', color: colors.text,
                        fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s', flexShrink: 0,
                      }}
                      onMouseEnter={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnHover)}
                      onMouseLeave={e => ((e.currentTarget as HTMLButtonElement).style.background = colors.btnBg)}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    </button>
                  </div>

                  {/* Label — bottom-left */}
                  {(w * CELL > 40 && h * CELL > 40) && (
                    <div style={{ position: 'absolute', bottom: 14, left: 14 }}>
                      <p style={{ fontSize: Math.min(18, w * CELL * 0.11), fontWeight: 800, lineHeight: 1, margin: 0, color: colors.text }}>
                        {colors.label}
                      </p>
                      <p style={{ fontSize: 10, opacity: 0.6, margin: '3px 0 0', whiteSpace: 'nowrap', color: colors.textSub }}>
                        {(m.type === 'small' || m.type === 'medium' || m.type === 'smalldeck') ? '2.4 × 2.4 m' : m.rotation % 2 !== 0 ? '2.4 × 4.8 m' : '4.8 × 2.4 m'}
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
        <Scene3D modules={modules} cols={cols} rows={rows} lightSettings={lightSettings} sceneSettings={sceneSettings} isDrawingMode={isDrawingMode} clearAnnotationsRef={clearAnnotationsRef} onAnnotationAdded={() => setHasAnnotations(true)} savedCameraRef={savedCameraRef} savedAnnotationsRef={savedAnnotationsRef} onFillClick={(mesh, x, y) => setFillPicker({ mesh, x, y })} exportSTLRef={exportSTLRef} />
        {fillPicker && (
          <div onClick={() => setFillPicker(null)} style={{ position: 'fixed', inset: 0, zIndex: 9998 }}>
            <div
              onClick={e => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: Math.min(fillPicker.x + 14, window.innerWidth - 190),
                top: Math.min(fillPicker.y + 14, window.innerHeight - 90),
                zIndex: 9999,
                background: 'rgba(18,20,30,0.97)',
                border: '1px solid rgba(255,255,255,0.13)',
                borderRadius: 12,
                padding: '10px 12px 12px',
                display: 'flex', flexDirection: 'column', gap: 9,
                boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
              }}
            >
              <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' }}>Boja površine</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', maxWidth: 172 }}>
                {FILL_COLORS.map(({ hex, label }) => (
                  <button
                    key={hex}
                    title={label}
                    onClick={() => applyFillColor(hex)}
                    style={{
                      width: 26, height: 26, borderRadius: '50%',
                      background: hex,
                      border: hex === '#ffffff' ? '2px solid rgba(255,255,255,0.3)' : '2px solid rgba(0,0,0,0.2)',
                      cursor: 'pointer', padding: 0,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
                      transition: 'transform 0.1s, box-shadow 0.1s',
                    }}
                    onMouseEnter={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'scale(1.25)'; b.style.boxShadow = `0 0 10px ${hex}`; }}
                    onMouseLeave={e => { const b = e.currentTarget as HTMLButtonElement; b.style.transform = 'scale(1)'; b.style.boxShadow = '0 2px 8px rgba(0,0,0,0.35)'; }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
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
        {/* ── Environment pill ─────────────────────────────────── */}
        <div style={{
          position: 'absolute', left: 24, top: '50%', transform: 'translateY(-50%)', zIndex: 10,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
          background: 'rgba(8,10,18,0.72)', backdropFilter: 'blur(16px)',
          borderRadius: 40, padding: '8px 7px',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.45)',
        }}>
          {([
            { key: 'dark',   dot: '#3b5ea6' },
            { key: 'trava',  dot: '#4ade80' },
            { key: 'suva',   dot: '#d4a84b' },
            { key: 'zemlja', dot: '#92614a' },
            { key: 'pesak',  dot: '#e2c97e' },
            { key: 'beton',  dot: '#9ca3af' },
          ] as { key: GrassType; dot: string }[]).map(opt => {
            const active = sceneSettings.grass === opt.key;
            return (
              <button key={opt.key}
                title={opt.key.charAt(0).toUpperCase() + opt.key.slice(1)}
                onClick={() => setSceneSettings(p => ({ ...p, grass: opt.key }))}
                style={{
                  width: active ? 28 : 22, height: active ? 28 : 22,
                  borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
                  background: active ? opt.dot : `${opt.dot}55`,
                  boxShadow: active ? `0 0 0 2px rgba(255,255,255,0.18), 0 0 12px ${opt.dot}66` : 'none',
                  transition: 'all 0.18s cubic-bezier(.4,0,.2,1)',
                  flexShrink: 0,
                }}
              />
            );
          })}
          <div style={{ width: 18, height: 1, background: 'rgba(255,255,255,0.08)', margin: '3px 0', flexShrink: 0 }} />
          <button
            title={sceneSettings.fogEnabled ? 'Magla uključena' : 'Magla isključena'}
            onClick={() => setSceneSettings(p => ({ ...p, fogEnabled: !p.fogEnabled }))}
            style={{
              width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
              background: sceneSettings.fogEnabled ? 'rgba(99,155,255,0.22)' : 'rgba(255,255,255,0.04)',
              color: sceneSettings.fogEnabled ? 'rgba(140,180,255,0.9)' : 'rgba(255,255,255,0.2)',
              fontSize: 14, transition: 'all 0.18s',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: sceneSettings.fogEnabled ? '0 0 10px rgba(99,155,255,0.3)' : 'none',
            }}
          >〜</button>
        </div>
        {/* ── Lighting control panel ───────────────────────────── */}
        {/* ── Lighting pill ────────────────────────────────────── */}
        <div style={{
          position: 'absolute', right: 24, top: '50%', transform: 'translateY(-50%)', zIndex: 10,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
          background: 'rgba(8,10,18,0.72)', backdropFilter: 'blur(16px)',
          borderRadius: 40, padding: '8px 7px',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 4px 24px rgba(0,0,0,0.45)',
        }}>
          {/* Dan / Noć */}
          <button
            title="Dan"
            onClick={() => setLightSettings(p => ({ ...p, isDay: true }))}
            style={{
              width: lightSettings.isDay ? 28 : 22, height: lightSettings.isDay ? 28 : 22,
              borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0, fontSize: 14,
              background: lightSettings.isDay ? 'rgba(245,158,11,0.25)' : 'rgba(255,255,255,0.04)',
              boxShadow: lightSettings.isDay ? '0 0 0 2px rgba(255,255,255,0.18), 0 0 12px rgba(245,158,11,0.5)' : 'none',
              transition: 'all 0.18s cubic-bezier(.4,0,.2,1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >☀️</button>
          <button
            title="Noć"
            onClick={() => setLightSettings(p => ({ ...p, isDay: false }))}
            style={{
              width: !lightSettings.isDay ? 28 : 22, height: !lightSettings.isDay ? 28 : 22,
              borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0, fontSize: 14,
              background: !lightSettings.isDay ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.04)',
              boxShadow: !lightSettings.isDay ? '0 0 0 2px rgba(255,255,255,0.18), 0 0 12px rgba(59,130,246,0.5)' : 'none',
              transition: 'all 0.18s cubic-bezier(.4,0,.2,1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}
          >🌙</button>
          <div style={{ width: 18, height: 1, background: 'rgba(255,255,255,0.08)', margin: '3px 0', flexShrink: 0 }} />
          {/* Pravac sunca — vertical slider */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', textTransform: 'uppercase', writingMode: 'vertical-rl', transform: 'rotate(180deg)', userSelect: 'none' }}>S</span>
            <input type="range" min={0} max={359} step={1} value={lightSettings.sunAngle}
              onChange={e => setLightSettings(p => ({ ...p, sunAngle: +e.target.value }))}
              title={`Pravac: ${sunDirectionLabel(lightSettings.sunAngle)}`}
              style={{
                writingMode: 'vertical-lr', direction: 'rtl',
                width: 4, height: 80, cursor: 'pointer',
                accentColor: lightSettings.isDay ? '#f59e0b' : '#3b82f6',
                appearance: 'slider-vertical' as React.CSSProperties['appearance'],
                WebkitAppearance: 'slider-vertical',
              }}
            />
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', textTransform: 'uppercase', writingMode: 'vertical-rl', transform: 'rotate(180deg)', userSelect: 'none' }}>J</span>
          </div>
          <div style={{ width: 18, height: 1, background: 'rgba(255,255,255,0.08)', margin: '3px 0', flexShrink: 0 }} />
          {/* Visina */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', userSelect: 'none' }}>▲</span>
            <input type="range" min={5} max={85} step={1} value={lightSettings.sunElevation}
              onChange={e => setLightSettings(p => ({ ...p, sunElevation: +e.target.value }))}
              title={`Visina: ${lightSettings.sunElevation}°`}
              style={{
                writingMode: 'vertical-lr', direction: 'rtl',
                width: 4, height: 64, cursor: 'pointer',
                accentColor: lightSettings.isDay ? '#f59e0b' : '#3b82f6',
                appearance: 'slider-vertical' as React.CSSProperties['appearance'],
                WebkitAppearance: 'slider-vertical',
              }}
            />
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.06em', userSelect: 'none' }}>▼</span>
          </div>
        </div>
      </div>
      )}

      {/* ── Module Options Modal ──────────────────────────────────── */}
      {optionsModalOpen && editingModuleId && (() => {
        const editingModule = modules.find(m => m.id === editingModuleId);
        if (!editingModule) return null;
        
        const activeCount = (editingModule.type === 'medium' || editingModule.type === 'small') ? [
          editingModule.hasKonstrukcija, editingModule.hasStakleniKrov, editingModule.hasFasada2PunZid,
          editingModule.hasFasada3PunZid, editingModule.hasFasada4PunZid, editingModule.hasFasada4PodiznoKlizna,
          editingModule.hasFasada4Fix, editingModule.hasKrovPun,
          editingModule.hasFasada1PodiznoKlizna, editingModule.hasFasada1Fix,
          editingModule.hasFasada2PodiznoKlizna, editingModule.hasFasada2Fix,
          editingModule.hasFasada3PodiznoKlizna, editingModule.hasFasada3Fix, editingModule.hasFasada1PunZid,
        ].filter(Boolean).length : editingModule.type === 'deck' ? [
          editingModule.hasTerasaDeckOtkrivena, editingModule.hasTerasaVelikaPergola,
        ].filter(Boolean).length : editingModule.type === 'smalldeck' ? [
          editingModule.hasTerasaDeckMala, editingModule.hasMalaPergolaDesnagore, editingModule.hasMalaPergolaLevaGore,
        ].filter(Boolean).length : [
          editingModule.hasKonstrukcija, editingModule.hasStakleniKrov, editingModule.hasFasada2PunZid, 
          editingModule.hasFasada1SaVratima, editingModule.hasFasada1BezVrata, editingModule.hasFasada4PodiznoKlizna, 
          editingModule.hasFasada4Fix, editingModule.hasFasada4KupatiloProzor, editingModule.hasFasada3ProzorSpavaca, 
          editingModule.hasFasada3PunZid, editingModule.hasKrovPun, editingModule.hasFasada4PunZid,
          editingModule.hasFasada1SaVratimaR, editingModule.hasFasada1BezVrataR, editingModule.hasFasada1PunZidR,
          editingModule.hasFasada3ProzorSpavacaR, editingModule.hasFasada3PunZidR,
        ].filter(Boolean).length;
        const maxCount = editingModule.type === 'large' ? 17 : (editingModule.type === 'medium' || editingModule.type === 'small') ? 15 : editingModule.type === 'deck' ? 2 : editingModule.type === 'smalldeck' ? 3 : 0;
        
        return (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 1000,
              background: 'rgba(0,0,0,0.88)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              backdropFilter: 'blur(12px)',
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setOptionsModalOpen(false); }}
          >
            <div className="tablet-modal-inner" style={{
              background: 'linear-gradient(135deg, rgba(17,17,24,0.98) 0%, rgba(24,24,36,0.98) 100%)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 20, 
              width: '98vw', 
              maxWidth: 1400,
              maxHeight: '90vh',
              display: 'flex', 
              flexDirection: 'row',
              fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",sans-serif',
              boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03)',
              overflow: 'hidden',
            }}>
              {/* LEFT — 3D preview */}
              <div style={{
                flex: 1,
                minWidth: 900,
                flexShrink: 1,
                background: 'rgba(0,0,0,0.35)',
                borderRight: '1px solid rgba(255,255,255,0.06)',
                borderRadius: '20px 0 0 20px',
                overflow: 'hidden',
                position: 'relative',
              }}>
                <div
                  ref={previewMountRef}
                  style={{ width: '100%', height: '100%', minHeight: 400 }}
                />
                {/* Watermark label */}
                <div style={{
                  position: 'absolute', bottom: 14, left: 0, right: 0,
                  textAlign: 'center',
                  fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.25)',
                  letterSpacing: 0.5, pointerEvents: 'none',
                }}>
                  3D PRIKAZ
                </div>
              </div>

              {/* RIGHT — header + scrollable options */}
              <div style={{ width: 480, flexShrink: 0, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
              {/* Header */}
              <div style={{ 
                padding: '24px 28px 20px', 
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>
                      Komponente modula
                    </h2>
                    <p style={{ margin: '6px 0 0', fontSize: 13, color: 'rgba(255,255,255,0.45)', fontWeight: 400 }}>
                      Prilagodi svoj modularni objekat
                    </p>
                  </div>
                  <button
                    onClick={() => setOptionsModalOpen(false)}
                    style={{ 
                      background: 'rgba(255,255,255,0.05)', 
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 8,
                      width: 32,
                      height: 32,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer', 
                      color: 'rgba(255,255,255,0.5)', 
                      fontSize: 18, 
                      lineHeight: 1,
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.1)';
                      (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.8)';
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
                      (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.5)';
                    }}
                  >×</button>
                </div>
                <div style={{ 
                  display: 'inline-flex', 
                  alignItems: 'center', 
                  gap: 8,
                  padding: '6px 12px',
                  background: activeCount === maxCount 
                    ? 'linear-gradient(135deg, rgba(34,197,94,0.15), rgba(16,185,129,0.15))' 
                    : 'rgba(255,255,255,0.04)',
                  border: activeCount === maxCount 
                    ? '1px solid rgba(34,197,94,0.3)' 
                    : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 8,
                }}>
                  <div style={{ 
                    fontSize: 18, 
                    fontWeight: 700, 
                    color: activeCount === maxCount ? '#22c55e' : '#fff',
                    letterSpacing: '-0.01em',
                  }}>
                    {activeCount}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>
                    / {maxCount} aktivno
                  </div>
                </div>
              </div>

              {/* Scrollable Content */}
              <div style={{ 
                flex: 1,
                overflowY: 'auto',
                padding: '20px 28px 24px',
                display: 'flex', 
                flexDirection: 'column', 
                gap: 24,
              }}
              className="custom-scrollbar"
              >
                
                {/* ── DECK TIP — posebne opcije ── */}
                {editingModule.type === 'deck' && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5, marginBottom: 12, textTransform: 'uppercase' }}>TERASA</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <button
                        onClick={() => toggleTerasaDeckOtkrivena(editingModuleId)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 14,
                          background: editingModule.hasTerasaDeckOtkrivena
                            ? 'linear-gradient(135deg, rgba(20,184,166,0.15) 0%, rgba(20,184,166,0.08) 100%)'
                            : 'rgba(255,255,255,0.03)',
                          border: editingModule.hasTerasaDeckOtkrivena ? '2px solid rgba(20,184,166,0.5)' : '2px solid rgba(255,255,255,0.08)',
                          borderRadius: 14, padding: '14px 16px',
                          cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule.hasTerasaDeckOtkrivena
                            ? '0 0 24px rgba(20,184,166,0.15), 0 4px 12px rgba(0,0,0,0.15)'
                            : '0 2px 8px rgba(0,0,0,0.08)',
                        }}
                        onMouseEnter={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasTerasaDeckOtkrivena ? 'linear-gradient(135deg, rgba(20,184,166,0.2) 0%, rgba(20,184,166,0.12) 100%)' : 'rgba(255,255,255,0.06)';
                          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01) translateY(-1px)';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasTerasaDeckOtkrivena ? 'linear-gradient(135deg, rgba(20,184,166,0.15) 0%, rgba(20,184,166,0.08) 100%)' : 'rgba(255,255,255,0.03)';
                          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        }}
                      >
                        <div style={{
                          width: 44, height: 24, borderRadius: 12,
                          background: editingModule.hasTerasaDeckOtkrivena
                            ? 'linear-gradient(135deg, rgba(20,184,166,0.95) 0%, rgba(13,148,136,0.95) 100%)'
                            : 'rgba(255,255,255,0.08)',
                          position: 'relative', flexShrink: 0,
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule.hasTerasaDeckOtkrivena ? '0 2px 8px rgba(20,184,166,0.3)' : 'none',
                        }}>
                          <div style={{
                            width: 18, height: 18, borderRadius: '50%', background: '#fff',
                            position: 'absolute', top: 3,
                            left: editingModule.hasTerasaDeckOtkrivena ? 23 : 3,
                            transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                          }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 2 }}>Deck otkrivena</div>
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Otvorena terasa bez pergole</div>
                        </div>
                        {editingModule.hasTerasaDeckOtkrivena && (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(20,184,166,0.95)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        )}
                      </button>

                      <button
                        onClick={() => toggleTerasaVelikaPergola(editingModuleId)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 14,
                          background: editingModule.hasTerasaVelikaPergola
                            ? 'linear-gradient(135deg, rgba(45,212,191,0.15) 0%, rgba(45,212,191,0.08) 100%)'
                            : 'rgba(255,255,255,0.03)',
                          border: editingModule.hasTerasaVelikaPergola ? '2px solid rgba(45,212,191,0.5)' : '2px solid rgba(255,255,255,0.08)',
                          borderRadius: 14, padding: '14px 16px',
                          cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule.hasTerasaVelikaPergola
                            ? '0 0 24px rgba(45,212,191,0.15), 0 4px 12px rgba(0,0,0,0.15)'
                            : '0 2px 8px rgba(0,0,0,0.08)',
                        }}
                        onMouseEnter={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasTerasaVelikaPergola ? 'linear-gradient(135deg, rgba(45,212,191,0.2) 0%, rgba(45,212,191,0.12) 100%)' : 'rgba(255,255,255,0.06)';
                          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01) translateY(-1px)';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasTerasaVelikaPergola ? 'linear-gradient(135deg, rgba(45,212,191,0.15) 0%, rgba(45,212,191,0.08) 100%)' : 'rgba(255,255,255,0.03)';
                          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        }}
                      >
                        <div style={{
                          width: 44, height: 24, borderRadius: 12,
                          background: editingModule.hasTerasaVelikaPergola
                            ? 'linear-gradient(135deg, rgba(45,212,191,0.95) 0%, rgba(20,184,166,0.95) 100%)'
                            : 'rgba(255,255,255,0.08)',
                          position: 'relative', flexShrink: 0,
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule.hasTerasaVelikaPergola ? '0 2px 8px rgba(45,212,191,0.3)' : 'none',
                        }}>
                          <div style={{
                            width: 18, height: 18, borderRadius: '50%', background: '#fff',
                            position: 'absolute', top: 3,
                            left: editingModule.hasTerasaVelikaPergola ? 23 : 3,
                            transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                          }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 2 }}>Velika pergola</div>
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Terasa sa velikom pergolom</div>
                        </div>
                        {editingModule.hasTerasaVelikaPergola && (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(45,212,191,0.95)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* ── SMALLDECK TIP — posebne opcije ── */}
                {editingModule.type === 'smalldeck' && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5, marginBottom: 12, textTransform: 'uppercase' }}>MALA TERASA</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {[
                        { key: 'hasTerasaDeckMala' as const, label: 'Deck mala', sub: 'Mala otvorena terasa', toggle: toggleTerasaDeckMala, color: '6,182,212' },
                        { key: 'hasMalaPergolaDesnagore' as const, label: 'Mala pergola desna', sub: 'Desna pergola gore', toggle: toggleMalaPergolaDesnagore, color: '34,211,238' },
                        { key: 'hasMalaPergolaLevaGore' as const, label: 'Mala pergola leva', sub: 'Leva pergola gore', toggle: toggleMalaPergolaLevaGore, color: '6,182,212' },
                      ].map(({ key, label, sub, toggle, color }) => (
                        <button
                          key={key}
                          onClick={() => toggle(editingModuleId)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 14,
                            background: editingModule[key]
                              ? `linear-gradient(135deg, rgba(${color},0.15) 0%, rgba(${color},0.08) 100%)`
                              : 'rgba(255,255,255,0.03)',
                            border: editingModule[key] ? `2px solid rgba(${color},0.5)` : '2px solid rgba(255,255,255,0.08)',
                            borderRadius: 14, padding: '14px 16px',
                            cursor: 'pointer', textAlign: 'left',
                            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                            boxShadow: editingModule[key]
                              ? `0 0 24px rgba(${color},0.15), 0 4px 12px rgba(0,0,0,0.15)`
                              : '0 2px 8px rgba(0,0,0,0.08)',
                          }}
                          onMouseEnter={e => {
                            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01) translateY(-1px)';
                          }}
                          onMouseLeave={e => {
                            (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                          }}
                        >
                          <div style={{
                            width: 44, height: 24, borderRadius: 12,
                            background: editingModule[key]
                              ? `linear-gradient(135deg, rgba(${color},0.95) 0%, rgba(${color},0.8) 100%)`
                              : 'rgba(255,255,255,0.08)',
                            position: 'relative', flexShrink: 0,
                            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                            boxShadow: editingModule[key] ? `0 2px 8px rgba(${color},0.3)` : 'none',
                          }}>
                            <div style={{
                              width: 18, height: 18, borderRadius: '50%', background: '#fff',
                              position: 'absolute', top: 3,
                              left: editingModule[key] ? 23 : 3,
                              transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                              boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                            }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 2 }}>{label}</div>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{sub}</div>
                          </div>
                          {editingModule[key] && (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={`rgba(${color},0.95)`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ostale opcije samo za ne-deck i ne-smalldeck tipove */}
                {editingModule.type !== 'deck' && editingModule.type !== 'smalldeck' && (<>
                {/* KONSTRUKCIJA */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5, marginBottom: 12, textTransform: 'uppercase' }}>KONSTRUKCIJA</div>
                  <button
                    onClick={() => toggleKonstrukcija(editingModuleId)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 14,
                      background: editingModule.hasKonstrukcija 
                        ? 'linear-gradient(135deg, rgba(249,115,22,0.15) 0%, rgba(249,115,22,0.08) 100%)' 
                        : 'rgba(255,255,255,0.03)',
                      border: editingModule.hasKonstrukcija ? '2px solid rgba(249,115,22,0.5)' : '2px solid rgba(255,255,255,0.08)',
                      borderRadius: 14, padding: '14px 16px',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                      boxShadow: editingModule.hasKonstrukcija 
                        ? '0 0 24px rgba(249,115,22,0.15), 0 4px 12px rgba(0,0,0,0.15)' 
                        : '0 2px 8px rgba(0,0,0,0.08)',
                    }}
                    onMouseEnter={e => {
                      (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasKonstrukcija 
                        ? 'linear-gradient(135deg, rgba(249,115,22,0.2) 0%, rgba(249,115,22,0.12) 100%)' 
                        : 'rgba(255,255,255,0.06)';
                      (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasKonstrukcija ? 'rgba(249,115,22,0.65)' : 'rgba(255,255,255,0.15)';
                      (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01) translateY(-1px)';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasKonstrukcija 
                        ? '0 0 32px rgba(249,115,22,0.25), 0 6px 16px rgba(0,0,0,0.2)' 
                        : '0 4px 12px rgba(0,0,0,0.12)';
                    }}
                    onMouseLeave={e => {
                      (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasKonstrukcija 
                        ? 'linear-gradient(135deg, rgba(249,115,22,0.15) 0%, rgba(249,115,22,0.08) 100%)' 
                        : 'rgba(255,255,255,0.03)';
                      (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasKonstrukcija ? 'rgba(249,115,22,0.5)' : 'rgba(255,255,255,0.08)';
                      (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                      (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasKonstrukcija 
                        ? '0 0 24px rgba(249,115,22,0.15), 0 4px 12px rgba(0,0,0,0.15)' 
                        : '0 2px 8px rgba(0,0,0,0.08)';
                    }}
                  >
                    <div style={{
                      width: 44, height: 24, borderRadius: 12,
                      background: editingModule.hasKonstrukcija 
                        ? 'linear-gradient(135deg, rgba(249,115,22,0.95) 0%, rgba(234,88,12,0.95) 100%)' 
                        : 'rgba(255,255,255,0.08)',
                      position: 'relative', flexShrink: 0,
                      transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                      boxShadow: editingModule.hasKonstrukcija ? '0 2px 8px rgba(249,115,22,0.3)' : 'none',
                    }}>
                      <div style={{
                        width: 18, height: 18, borderRadius: '50%',
                        background: '#fff',
                        position: 'absolute', top: 3,
                        left: editingModule.hasKonstrukcija ? 23 : 3,
                        transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                      }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 2 }}>Konstrukcija</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Konstruktivni elementi</div>
                    </div>
                    {editingModule.hasKonstrukcija && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(249,115,22,0.95)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(249,115,22,0.4))' }}>
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                </div>

                {/* KROVOVI */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5, marginBottom: 12, textTransform: 'uppercase' }}>KROVOVI</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <button
                      onClick={() => toggleKrovPun(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        background: editingModule.hasKrovPun 
                          ? 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.08) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasKrovPun ? '2px solid rgba(59,130,246,0.5)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 14, padding: '14px 16px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasKrovPun 
                          ? '0 0 24px rgba(59,130,246,0.15), 0 4px 12px rgba(0,0,0,0.15)' 
                          : '0 2px 8px rgba(0,0,0,0.08)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasKrovPun 
                          ? 'linear-gradient(135deg, rgba(59,130,246,0.2) 0%, rgba(59,130,246,0.12) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasKrovPun ? 'rgba(59,130,246,0.65)' : 'rgba(255,255,255,0.15)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01) translateY(-1px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasKrovPun 
                          ? '0 0 32px rgba(59,130,246,0.25), 0 6px 16px rgba(0,0,0,0.2)' 
                          : '0 4px 12px rgba(0,0,0,0.12)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasKrovPun 
                          ? 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.08) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasKrovPun ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasKrovPun 
                          ? '0 0 24px rgba(59,130,246,0.15), 0 4px 12px rgba(0,0,0,0.15)' 
                          : '0 2px 8px rgba(0,0,0,0.08)';
                      }}
                    >
                      <div style={{
                        width: 44, height: 24, borderRadius: 12,
                        background: editingModule.hasKrovPun 
                          ? 'linear-gradient(135deg, rgba(59,130,246,0.95) 0%, rgba(37,99,235,0.95) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasKrovPun ? '0 2px 8px rgba(59,130,246,0.3)' : 'none',
                      }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasKrovPun ? 23 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                        }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 2 }}>Puni krov</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Standardni krov</div>
                      </div>
                      {editingModule.hasKrovPun && (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(59,130,246,0.95)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(59,130,246,0.4))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={() => toggleStakleniKrov(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 14,
                        background: editingModule.hasStakleniKrov 
                          ? 'linear-gradient(135deg, rgba(20,184,166,0.15) 0%, rgba(20,184,166,0.08) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasStakleniKrov ? '2px solid rgba(20,184,166,0.5)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 14, padding: '14px 16px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasStakleniKrov 
                          ? '0 0 24px rgba(20,184,166,0.15), 0 4px 12px rgba(0,0,0,0.15)' 
                          : '0 2px 8px rgba(0,0,0,0.08)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasStakleniKrov 
                          ? 'linear-gradient(135deg, rgba(20,184,166,0.2) 0%, rgba(20,184,166,0.12) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasStakleniKrov ? 'rgba(20,184,166,0.65)' : 'rgba(255,255,255,0.15)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.01) translateY(-1px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasStakleniKrov 
                          ? '0 0 32px rgba(20,184,166,0.25), 0 6px 16px rgba(0,0,0,0.2)' 
                          : '0 4px 12px rgba(0,0,0,0.12)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasStakleniKrov 
                          ? 'linear-gradient(135deg, rgba(20,184,166,0.15) 0%, rgba(20,184,166,0.08) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasStakleniKrov ? 'rgba(20,184,166,0.5)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasStakleniKrov 
                          ? '0 0 24px rgba(20,184,166,0.15), 0 4px 12px rgba(0,0,0,0.15)' 
                          : '0 2px 8px rgba(0,0,0,0.08)';
                      }}
                    >
                      <div style={{
                        width: 44, height: 24, borderRadius: 12,
                        background: editingModule.hasStakleniKrov 
                          ? 'linear-gradient(135deg, rgba(20,184,166,0.95) 0%, rgba(13,148,136,0.95) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasStakleniKrov ? '0 2px 8px rgba(20,184,166,0.3)' : 'none',
                      }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasStakleniKrov ? 23 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
                        }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.95)', marginBottom: 2 }}>Stakleni krov</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Krov sa staklom</div>
                      </div>
                      {editingModule.hasStakleniKrov && (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(20,184,166,0.95)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 4px rgba(20,184,166,0.4))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {/* FASADE */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.5, marginBottom: 12, textTransform: 'uppercase' }}>FASADE</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                    {/* ── LARGE: fasade 1→4 u redosledu ── */}
                    {editingModule.type === 'large' && [
                      { key: 'hasFasada1SaVratima' as const,     label: 'Fasada 1 - Sa vratima',     toggle: toggleFasada1SaVratima,     color: '168,85,247',  color2: '147,2,234'   },
                      { key: 'hasFasada1BezVrata' as const,      label: 'Fasada 1 - Bez vrata',      toggle: toggleFasada1BezVrata,      color: '236,72,153',  color2: '219,39,119'  },
                      { key: 'hasFasada2PunZid' as const,        label: 'Fasada 2 - Puni zid',       toggle: toggleFasada2PunZid,        color: '34,197,94',   color2: '22,163,74'   },
                      { key: 'hasFasada3ProzorSpavaca' as const, label: 'Fasada 3 - Spavaća soba',   toggle: toggleFasada3ProzorSpavaca, color: '244,63,94',   color2: '225,29,72'   },
                      { key: 'hasFasada3PunZid' as const,        label: 'Fasada 3 - Puni zid',       toggle: toggleFasada3PunZid,        color: '132,204,22',  color2: '101,163,13'  },
                      { key: 'hasFasada4PodiznoKlizna' as const, label: 'Fasada 4 - Podizno klizna', toggle: toggleFasada4PodiznoKlizna, color: '245,158,11',  color2: '217,119,6'   },
                      { key: 'hasFasada4Fix' as const,           label: 'Fasada 4 - Fiksna',         toggle: toggleFasada4Fix,           color: '99,102,241',  color2: '79,70,229'   },
                      { key: 'hasFasada4KupatiloProzor' as const,label: 'Fasada 4 - Kupatilo',       toggle: toggleFasada4KupatiloProzor,color: '6,182,212',   color2: '8,145,178'   },
                      { key: 'hasFasada4PunZid' as const,        label: 'Fasada 4 - Puni zid',       toggle: toggleFasada4PunZid,        color: '147,51,234',  color2: '126,34,206'  },
                    ].map(({ key, label, toggle, color, color2 }) => (
                      <button key={key}
                        onClick={() => toggle(editingModuleId)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          background: editingModule[key] ? `linear-gradient(135deg, rgba(${color},0.14) 0%, rgba(${color},0.07) 100%)` : 'rgba(255,255,255,0.03)',
                          border: editingModule[key] ? `2px solid rgba(${color},0.48)` : '2px solid rgba(255,255,255,0.08)',
                          borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule[key] ? `0 0 20px rgba(${color},0.12), 0 3px 10px rgba(0,0,0,0.12)` : '0 2px 6px rgba(0,0,0,0.06)',
                        }}
                        onMouseEnter={e => {
                          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                          (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule[key] ? `0 0 28px rgba(${color},0.2), 0 5px 14px rgba(0,0,0,0.16)` : '0 3px 10px rgba(0,0,0,0.10)';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                          (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule[key] ? `0 0 20px rgba(${color},0.12), 0 3px 10px rgba(0,0,0,0.12)` : '0 2px 6px rgba(0,0,0,0.06)';
                        }}
                      >
                        <div style={{
                          width: 40, height: 22, borderRadius: 11,
                          background: editingModule[key] ? `linear-gradient(135deg, rgba(${color},0.92) 0%, rgba(${color2},0.92) 100%)` : 'rgba(255,255,255,0.08)',
                          position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule[key] ? `0 2px 6px rgba(${color},0.25)` : 'none',
                        }}>
                          <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff',
                            position: 'absolute', top: 3, left: editingModule[key] ? 21 : 3,
                            transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                          }} />
                        </div>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>{label}</div>
                        {editingModule[key] && (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={`rgba(${color},0.92)`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px rgba(${color},0.35))` }}>
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        )}
                      </button>
                    ))}
                    {/* ── MEDIUM/SMALL: fasade 1→4 u redosledu ── */}
                    {(editingModule.type === 'medium' || editingModule.type === 'small') && [
                      { key: 'hasFasada1PunZid' as const,        label: 'Fasada 1 - Puni zid',       toggle: toggleFasada1PunZid,        color: '249,115,22',  color2: '234,88,12'   },
                      { key: 'hasFasada1PodiznoKlizna' as const, label: 'Fasada 1 - Podizno klizna', toggle: toggleFasada1PodiznoKlizna, color: '20,184,166',  color2: '13,148,136'  },
                      { key: 'hasFasada1Fix' as const,           label: 'Fasada 1 - Fiksna',         toggle: toggleFasada1Fix,           color: '14,165,233',  color2: '2,132,199'   },
                      { key: 'hasFasada2PodiznoKlizna' as const, label: 'Fasada 2 - Podizno klizna', toggle: toggleFasada2PodiznoKlizna, color: '217,70,239',  color2: '192,38,211'  },
                      { key: 'hasFasada2Fix' as const,           label: 'Fasada 2 - Fiksna',         toggle: toggleFasada2Fix,           color: '16,185,129',  color2: '5,150,105'   },
                      { key: 'hasFasada2PunZid' as const,        label: 'Fasada 2 - Puni zid',       toggle: toggleFasada2PunZid,        color: '34,197,94',   color2: '22,163,74'   },
                      { key: 'hasFasada3PodiznoKlizna' as const, label: 'Fasada 3 - Podizno klizna', toggle: toggleFasada3PodiznoKlizna, color: '234,179,8',   color2: '202,138,4'   },
                      { key: 'hasFasada3Fix' as const,           label: 'Fasada 3 - Fiksna',         toggle: toggleFasada3Fix,           color: '239,68,68',   color2: '220,38,38'   },
                      { key: 'hasFasada3PunZid' as const,        label: 'Fasada 3 - Puni zid',       toggle: toggleFasada3PunZid,        color: '132,204,22',  color2: '101,163,13'  },
                      { key: 'hasFasada4PodiznoKlizna' as const, label: 'Fasada 4 - Podizno klizna', toggle: toggleFasada4PodiznoKlizna, color: '245,158,11',  color2: '217,119,6'   },
                      { key: 'hasFasada4Fix' as const,           label: 'Fasada 4 - Fiksna',         toggle: toggleFasada4Fix,           color: '99,102,241',  color2: '79,70,229'   },
                      { key: 'hasFasada4PunZid' as const,        label: 'Fasada 4 - Puni zid',       toggle: toggleFasada4PunZid,        color: '147,51,234',  color2: '126,34,206'  },
                    ].map(({ key, label, toggle, color, color2 }) => (
                      <button key={key} onClick={() => toggle(editingModuleId)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12,
                          background: editingModule[key] ? `linear-gradient(135deg, rgba(${color},0.14) 0%, rgba(${color},0.07) 100%)` : 'rgba(255,255,255,0.03)',
                          border: editingModule[key] ? `2px solid rgba(${color},0.48)` : '2px solid rgba(255,255,255,0.08)',
                          borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule[key] ? `0 0 20px rgba(${color},0.12), 0 3px 10px rgba(0,0,0,0.12)` : '0 2px 6px rgba(0,0,0,0.06)',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)'; }}
                      >
                        <div style={{ width: 40, height: 22, borderRadius: 11,
                          background: editingModule[key] ? `linear-gradient(135deg, rgba(${color},0.92) 0%, rgba(${color2},0.92) 100%)` : 'rgba(255,255,255,0.08)',
                          position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: editingModule[key] ? `0 2px 6px rgba(${color},0.25)` : 'none',
                        }}>
                          <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff',
                            position: 'absolute', top: 3, left: editingModule[key] ? 21 : 3,
                            transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                          }} />
                        </div>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>{label}</div>
                        {editingModule[key] && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={`rgba(${color},0.92)`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 3px rgba(${color},0.35))` }}><polyline points="20 6 9 17 4 12"/></svg>)}
                      </button>
                    ))}
                    {/*<button
                      onClick={() => toggleFasada2PunZid(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada2PunZid 
                          ? 'linear-gradient(135deg, rgba(34,197,94,0.14) 0%, rgba(34,197,94,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada2PunZid ? '2px solid rgba(34,197,94,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada2PunZid 
                          ? '0 0 20px rgba(34,197,94,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada2PunZid 
                          ? 'linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada2PunZid ? 'rgba(34,197,94,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada2PunZid 
                          ? '0 0 28px rgba(34,197,94,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada2PunZid 
                          ? 'linear-gradient(135deg, rgba(34,197,94,0.14) 0%, rgba(34,197,94,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada2PunZid ? 'rgba(34,197,94,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada2PunZid 
                          ? '0 0 20px rgba(34,197,94,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada2PunZid 
                          ? 'linear-gradient(135deg, rgba(34,197,94,0.92) 0%, rgba(22,163,74,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada2PunZid ? '0 2px 6px rgba(34,197,94,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada2PunZid ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 2 - Puni zid</div>
                      {editingModule.hasFasada2PunZid && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(34,197,94,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(34,197,94,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    {editingModule.type === 'large' && (<>
                    <button
                      onClick={() => toggleFasada1SaVratima(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada1SaVratima 
                          ? 'linear-gradient(135deg, rgba(168,85,247,0.14) 0%, rgba(168,85,247,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada1SaVratima ? '2px solid rgba(168,85,247,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada1SaVratima 
                          ? '0 0 20px rgba(168,85,247,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada1SaVratima 
                          ? 'linear-gradient(135deg, rgba(168,85,247,0.18) 0%, rgba(168,85,247,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada1SaVratima ? 'rgba(168,85,247,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada1SaVratima 
                          ? '0 0 28px rgba(168,85,247,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada1SaVratima 
                          ? 'linear-gradient(135deg, rgba(168,85,247,0.14) 0%, rgba(168,85,247,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada1SaVratima ? 'rgba(168,85,247,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada1SaVratima 
                          ? '0 0 20px rgba(168,85,247,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada1SaVratima 
                          ? 'linear-gradient(135deg, rgba(168,85,247,0.92) 0%, rgba(147,2,234,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada1SaVratima ? '0 2px 6px rgba(168,85,247,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada1SaVratima ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 1 - Sa vratima</div>
                      {editingModule.hasFasada1SaVratima && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(168,85,247,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(168,85,247,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={() => toggleFasada1BezVrata(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada1BezVrata 
                          ? 'linear-gradient(135deg, rgba(236,72,153,0.14) 0%, rgba(236,72,153,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada1BezVrata ? '2px solid rgba(236,72,153,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada1BezVrata 
                          ? '0 0 20px rgba(236,72,153,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada1BezVrata 
                          ? 'linear-gradient(135deg, rgba(236,72,153,0.18) 0%, rgba(236,72,153,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada1BezVrata ? 'rgba(236,72,153,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada1BezVrata 
                          ? '0 0 28px rgba(236,72,153,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada1BezVrata 
                          ? 'linear-gradient(135deg, rgba(236,72,153,0.14) 0%, rgba(236,72,153,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada1BezVrata ? 'rgba(236,72,153,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada1BezVrata 
                          ? '0 0 20px rgba(236,72,153,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada1BezVrata 
                          ? 'linear-gradient(135deg, rgba(236,72,153,0.92) 0%, rgba(219,39,119,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada1BezVrata ? '0 2px 6px rgba(236,72,153,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada1BezVrata ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 1 - Bez vrata</div>
                      {editingModule.hasFasada1BezVrata && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(236,72,153,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(236,72,153,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                    </>)}

                    <button
                      onClick={() => toggleFasada4PodiznoKlizna(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada4PodiznoKlizna 
                          ? 'linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(245,158,11,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada4PodiznoKlizna ? '2px solid rgba(245,158,11,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4PodiznoKlizna 
                          ? '0 0 20px rgba(245,158,11,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4PodiznoKlizna 
                          ? 'linear-gradient(135deg, rgba(245,158,11,0.18) 0%, rgba(245,158,11,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4PodiznoKlizna ? 'rgba(245,158,11,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4PodiznoKlizna 
                          ? '0 0 28px rgba(245,158,11,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4PodiznoKlizna 
                          ? 'linear-gradient(135deg, rgba(245,158,11,0.14) 0%, rgba(245,158,11,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4PodiznoKlizna ? 'rgba(245,158,11,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4PodiznoKlizna 
                          ? '0 0 20px rgba(245,158,11,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada4PodiznoKlizna 
                          ? 'linear-gradient(135deg, rgba(245,158,11,0.92) 0%, rgba(217,119,6,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4PodiznoKlizna ? '0 2px 6px rgba(245,158,11,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada4PodiznoKlizna ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 4 - Podizno klizna</div>
                      {editingModule.hasFasada4PodiznoKlizna && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(245,158,11,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(245,158,11,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={() => toggleFasada4Fix(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada4Fix 
                          ? 'linear-gradient(135deg, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada4Fix ? '2px solid rgba(99,102,241,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4Fix 
                          ? '0 0 20px rgba(99,102,241,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4Fix 
                          ? 'linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(99,102,241,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4Fix ? 'rgba(99,102,241,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4Fix 
                          ? '0 0 28px rgba(99,102,241,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4Fix 
                          ? 'linear-gradient(135deg, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4Fix ? 'rgba(99,102,241,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4Fix 
                          ? '0 0 20px rgba(99,102,241,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada4Fix 
                          ? 'linear-gradient(135deg, rgba(99,102,241,0.92) 0%, rgba(79,70,229,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4Fix ? '0 2px 6px rgba(99,102,241,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada4Fix ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 4 - Fiksna</div>
                      {editingModule.hasFasada4Fix && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(99,102,241,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(99,102,241,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    {editingModule.type === 'large' && (<>
                    <button
                      onClick={() => toggleFasada4KupatiloProzor(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada4KupatiloProzor 
                          ? 'linear-gradient(135deg, rgba(6,182,212,0.14) 0%, rgba(6,182,212,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada4KupatiloProzor ? '2px solid rgba(6,182,212,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4KupatiloProzor 
                          ? '0 0 20px rgba(6,182,212,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4KupatiloProzor 
                          ? 'linear-gradient(135deg, rgba(6,182,212,0.18) 0%, rgba(6,182,212,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4KupatiloProzor ? 'rgba(6,182,212,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4KupatiloProzor 
                          ? '0 0 28px rgba(6,182,212,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4KupatiloProzor 
                          ? 'linear-gradient(135deg, rgba(6,182,212,0.14) 0%, rgba(6,182,212,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4KupatiloProzor ? 'rgba(6,182,212,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4KupatiloProzor 
                          ? '0 0 20px rgba(6,182,212,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada4KupatiloProzor 
                          ? 'linear-gradient(135deg, rgba(6,182,212,0.92) 0%, rgba(8,145,178,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4KupatiloProzor ? '0 2px 6px rgba(6,182,212,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada4KupatiloProzor ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 4 - Kupatilo</div>
                      {editingModule.hasFasada4KupatiloProzor && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(6,182,212,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(6,182,212,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={() => toggleFasada3ProzorSpavaca(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada3ProzorSpavaca 
                          ? 'linear-gradient(135deg, rgba(244,63,94,0.14) 0%, rgba(244,63,94,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada3ProzorSpavaca ? '2px solid rgba(244,63,94,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada3ProzorSpavaca 
                          ? '0 0 20px rgba(244,63,94,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada3ProzorSpavaca 
                          ? 'linear-gradient(135deg, rgba(244,63,94,0.18) 0%, rgba(244,63,94,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada3ProzorSpavaca ? 'rgba(244,63,94,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada3ProzorSpavaca 
                          ? '0 0 28px rgba(244,63,94,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada3ProzorSpavaca 
                          ? 'linear-gradient(135deg, rgba(244,63,94,0.14) 0%, rgba(244,63,94,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada3ProzorSpavaca ? 'rgba(244,63,94,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada3ProzorSpavaca 
                          ? '0 0 20px rgba(244,63,94,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada3ProzorSpavaca 
                          ? 'linear-gradient(135deg, rgba(244,63,94,0.92) 0%, rgba(225,29,72,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada3ProzorSpavaca ? '0 2px 6px rgba(244,63,94,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada3ProzorSpavaca ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 3 - Spavaća soba</div>
                      {editingModule.hasFasada3ProzorSpavaca && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(244,63,94,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(244,63,94,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                    </>)}

                    <button
                      onClick={() => toggleFasada3PunZid(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada3PunZid 
                          ? 'linear-gradient(135deg, rgba(132,204,22,0.14) 0%, rgba(132,204,22,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada3PunZid ? '2px solid rgba(132,204,22,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada3PunZid 
                          ? '0 0 20px rgba(132,204,22,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada3PunZid 
                          ? 'linear-gradient(135deg, rgba(132,204,22,0.18) 0%, rgba(132,204,22,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada3PunZid ? 'rgba(132,204,22,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada3PunZid 
                          ? '0 0 28px rgba(132,204,22,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada3PunZid 
                          ? 'linear-gradient(135deg, rgba(132,204,22,0.14) 0%, rgba(132,204,22,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada3PunZid ? 'rgba(132,204,22,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada3PunZid 
                          ? '0 0 20px rgba(132,204,22,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada3PunZid 
                          ? 'linear-gradient(135deg, rgba(132,204,22,0.92) 0%, rgba(101,163,13,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada3PunZid ? '0 2px 6px rgba(132,204,22,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada3PunZid ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 3 - Puni zid</div>
                      {editingModule.hasFasada3PunZid && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(132,204,22,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(132,204,22,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    <button
                      onClick={() => toggleFasada4PunZid(editingModuleId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        background: editingModule.hasFasada4PunZid 
                          ? 'linear-gradient(135deg, rgba(147,51,234,0.14) 0%, rgba(147,51,234,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)',
                        border: editingModule.hasFasada4PunZid ? '2px solid rgba(147,51,234,0.48)' : '2px solid rgba(255,255,255,0.08)',
                        borderRadius: 13, padding: '11px 14px',
                        cursor: 'pointer', textAlign: 'left',
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4PunZid 
                          ? '0 0 20px rgba(147,51,234,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4PunZid 
                          ? 'linear-gradient(135deg, rgba(147,51,234,0.18) 0%, rgba(147,51,234,0.10) 100%)' 
                          : 'rgba(255,255,255,0.06)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4PunZid ? 'rgba(147,51,234,0.6)' : 'rgba(255,255,255,0.14)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4PunZid 
                          ? '0 0 28px rgba(147,51,234,0.2), 0 5px 14px rgba(0,0,0,0.16)' 
                          : '0 3px 10px rgba(0,0,0,0.10)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.background = editingModule.hasFasada4PunZid 
                          ? 'linear-gradient(135deg, rgba(147,51,234,0.14) 0%, rgba(147,51,234,0.07) 100%)' 
                          : 'rgba(255,255,255,0.03)';
                        (e.currentTarget as HTMLButtonElement).style.borderColor = editingModule.hasFasada4PunZid ? 'rgba(147,51,234,0.48)' : 'rgba(255,255,255,0.08)';
                        (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)';
                        (e.currentTarget as HTMLButtonElement).style.boxShadow = editingModule.hasFasada4PunZid 
                          ? '0 0 20px rgba(147,51,234,0.12), 0 3px 10px rgba(0,0,0,0.12)' 
                          : '0 2px 6px rgba(0,0,0,0.06)';
                      }}
                    >
                      <div style={{
                        width: 40, height: 22, borderRadius: 11,
                        background: editingModule.hasFasada4PunZid 
                          ? 'linear-gradient(135deg, rgba(147,51,234,0.92) 0%, rgba(126,34,206,0.92) 100%)' 
                          : 'rgba(255,255,255,0.08)',
                        position: 'relative', flexShrink: 0,
                        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                        boxShadow: editingModule.hasFasada4PunZid ? '0 2px 6px rgba(147,51,234,0.25)' : 'none',
                      }}>
                        <div style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: '#fff',
                          position: 'absolute', top: 3,
                          left: editingModule.hasFasada4PunZid ? 21 : 3,
                          transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                        }} />
                      </div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 4 - Puni zid</div>
                      {editingModule.hasFasada4PunZid && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(147,51,234,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 3px rgba(147,51,234,0.35))' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>

                    {(editingModule.type === 'medium' || editingModule.type === 'small') && (<>
                    <button onClick={() => toggleFasada1PunZid(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada1PunZid ? 'linear-gradient(135deg, rgba(249,115,22,0.14) 0%, rgba(249,115,22,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada1PunZid ? '2px solid rgba(249,115,22,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada1PunZid ? '0 0 20px rgba(249,115,22,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada1PunZid ? 'linear-gradient(135deg, rgba(249,115,22,0.92) 0%, rgba(234,88,12,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada1PunZid ? '0 2px 6px rgba(249,115,22,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada1PunZid ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 1 - Puni zid</div>
                      {editingModule.hasFasada1PunZid && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(249,115,22,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>

                    <button onClick={() => toggleFasada1PodiznoKlizna(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada1PodiznoKlizna ? 'linear-gradient(135deg, rgba(20,184,166,0.14) 0%, rgba(20,184,166,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada1PodiznoKlizna ? '2px solid rgba(20,184,166,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada1PodiznoKlizna ? '0 0 20px rgba(20,184,166,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada1PodiznoKlizna ? 'linear-gradient(135deg, rgba(20,184,166,0.92) 0%, rgba(13,148,136,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada1PodiznoKlizna ? '0 2px 6px rgba(20,184,166,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada1PodiznoKlizna ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 1 - Podizno klizna</div>
                      {editingModule.hasFasada1PodiznoKlizna && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(20,184,166,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>

                    <button onClick={() => toggleFasada1Fix(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada1Fix ? 'linear-gradient(135deg, rgba(14,165,233,0.14) 0%, rgba(14,165,233,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada1Fix ? '2px solid rgba(14,165,233,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada1Fix ? '0 0 20px rgba(14,165,233,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada1Fix ? 'linear-gradient(135deg, rgba(14,165,233,0.92) 0%, rgba(2,132,199,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada1Fix ? '0 2px 6px rgba(14,165,233,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada1Fix ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 1 - Fiksna</div>
                      {editingModule.hasFasada1Fix && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(14,165,233,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>

                    <button onClick={() => toggleFasada2PodiznoKlizna(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada2PodiznoKlizna ? 'linear-gradient(135deg, rgba(217,70,239,0.14) 0%, rgba(217,70,239,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada2PodiznoKlizna ? '2px solid rgba(217,70,239,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada2PodiznoKlizna ? '0 0 20px rgba(217,70,239,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada2PodiznoKlizna ? 'linear-gradient(135deg, rgba(217,70,239,0.92) 0%, rgba(192,38,211,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada2PodiznoKlizna ? '0 2px 6px rgba(217,70,239,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada2PodiznoKlizna ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 2 - Podizno klizna</div>
                      {editingModule.hasFasada2PodiznoKlizna && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(217,70,239,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>

                    <button onClick={() => toggleFasada2Fix(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada2Fix ? 'linear-gradient(135deg, rgba(16,185,129,0.14) 0%, rgba(16,185,129,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada2Fix ? '2px solid rgba(16,185,129,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada2Fix ? '0 0 20px rgba(16,185,129,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada2Fix ? 'linear-gradient(135deg, rgba(16,185,129,0.92) 0%, rgba(5,150,105,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada2Fix ? '0 2px 6px rgba(16,185,129,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada2Fix ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 2 - Fiksna</div>
                      {editingModule.hasFasada2Fix && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(16,185,129,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>

                    <button onClick={() => toggleFasada3PodiznoKlizna(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada3PodiznoKlizna ? 'linear-gradient(135deg, rgba(234,179,8,0.14) 0%, rgba(234,179,8,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada3PodiznoKlizna ? '2px solid rgba(234,179,8,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada3PodiznoKlizna ? '0 0 20px rgba(234,179,8,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada3PodiznoKlizna ? 'linear-gradient(135deg, rgba(234,179,8,0.92) 0%, rgba(202,138,4,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada3PodiznoKlizna ? '0 2px 6px rgba(234,179,8,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada3PodiznoKlizna ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 3 - Podizno klizna</div>
                      {editingModule.hasFasada3PodiznoKlizna && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(234,179,8,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>

                    <button onClick={() => toggleFasada3Fix(editingModuleId)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: editingModule.hasFasada3Fix ? 'linear-gradient(135deg, rgba(239,68,68,0.14) 0%, rgba(239,68,68,0.07) 100%)' : 'rgba(255,255,255,0.03)', border: editingModule.hasFasada3Fix ? '2px solid rgba(239,68,68,0.48)' : '2px solid rgba(255,255,255,0.08)', borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada3Fix ? '0 0 20px rgba(239,68,68,0.12), 0 3px 10px rgba(0,0,0,0.12)' : '0 2px 6px rgba(0,0,0,0.06)' }}>
                      <div style={{ width: 40, height: 22, borderRadius: 11, background: editingModule.hasFasada3Fix ? 'linear-gradient(135deg, rgba(239,68,68,0.92) 0%, rgba(220,38,38,0.92) 100%)' : 'rgba(255,255,255,0.08)', position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: editingModule.hasFasada3Fix ? '0 2px 6px rgba(239,68,68,0.25)' : 'none' }}><div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: editingModule.hasFasada3Fix ? 21 : 3, transition: 'left 0.4s cubic-bezier(0.4, 0, 0.2, 1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)' }} /></div>
                      <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>Fasada 3 - Fiksna</div>
                      {editingModule.hasFasada3Fix && (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(239,68,68,0.92)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>)}
                    </button>
                    </>)}
                    */}

                    {/* _R grupe — samo za large_full_modul.glb */}
                    {editingModule.type === 'large' && (<>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: 0.5, margin: '6px 0 10px', textTransform: 'uppercase' }}>DESNA STRANA (_R)</div>
                    {[
                      { key: 'hasFasada1SaVratimaR' as const,    label: 'Fasada 1D - Sa vratima',     toggle: toggleFasada1SaVratimaR,    color: '168,85,247' },
                      { key: 'hasFasada1BezVrataR' as const,     label: 'Fasada 1D - Bez vrata',      toggle: toggleFasada1BezVrataR,     color: '236,72,153' },
                      { key: 'hasFasada1PunZidR' as const,       label: 'Fasada 1D - Puni zid',       toggle: toggleFasada1PunZidR,       color: '249,115,22' },
                      { key: 'hasFasada3ProzorSpavacaR' as const, label: 'Fasada 3D - Prozor spavaća', toggle: toggleFasada3ProzorSpavacaR, color: '59,130,246' },
                      { key: 'hasFasada3PunZidR' as const,       label: 'Fasada 3D - Puni zid',       toggle: toggleFasada3PunZidR,       color: '132,204,22' },
                    ].map(({ key, label, toggle, color }) => (
                      <button key={key} onClick={() => toggle(editingModuleId)}
                        style={{ display: 'flex', alignItems: 'center', gap: 12,
                          background: editingModule[key] ? `linear-gradient(135deg,rgba(${color},0.14) 0%,rgba(${color},0.07) 100%)` : 'rgba(255,255,255,0.03)',
                          border: editingModule[key] ? `2px solid rgba(${color},0.48)` : '2px solid rgba(255,255,255,0.08)',
                          borderRadius: 13, padding: '11px 14px', cursor: 'pointer', textAlign: 'left',
                          transition: 'all 0.4s cubic-bezier(0.4,0,0.2,1)',
                          boxShadow: editingModule[key] ? `0 0 20px rgba(${color},0.12),0 3px 10px rgba(0,0,0,0.12)` : '0 2px 6px rgba(0,0,0,0.06)',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.008) translateY(-0.5px)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1) translateY(0)'; }}
                      >
                        <div style={{ width: 40, height: 22, borderRadius: 11,
                          background: editingModule[key] ? `linear-gradient(135deg,rgba(${color},0.92) 0%,rgba(${color},0.75) 100%)` : 'rgba(255,255,255,0.08)',
                          position: 'relative', flexShrink: 0, transition: 'all 0.4s cubic-bezier(0.4,0,0.2,1)',
                          boxShadow: editingModule[key] ? `0 2px 6px rgba(${color},0.25)` : 'none',
                        }}>
                          <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff',
                            position: 'absolute', top: 3, left: editingModule[key] ? 21 : 3,
                            transition: 'left 0.4s cubic-bezier(0.4,0,0.2,1)', boxShadow: '0 2px 5px rgba(0,0,0,0.25)',
                          }} />
                        </div>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.93)' }}>{label}</div>
                        {editingModule[key] && (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={`rgba(${color},0.92)`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                      </button>
                    ))}
                    </>)}
                  </div>
                </div>
                </>)}{/* end non-deck content */}
              </div>
            </div>
            </div>{/* end RIGHT column */}
          </div>
        );
      })()}

      {/* ── Objekti Modal ── */}
      {objektiModalOpen && (
        <div
          onClick={() => setObjektiModalOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#141418', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 20, width: 560, maxWidth: '95vw', maxHeight: '80vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Objekti</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>Dodaj 3D objekte u scenu</div>
              </div>
              <button
                onClick={() => setObjektiModalOpen(false)}
                style={{ width: 28, height: 28, borderRadius: '50%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >✕</button>
            </div>
            {/* Content */}
            <div style={{ padding: '16px 24px 24px', overflowY: 'auto' }} className="custom-scrollbar">
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 }}>Dostupni objekti</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                {[
                  { name: 'Lampa', icon: '💡', desc: 'Spoljna lampa', soon: true },
                  { name: 'Cveće', icon: '🌿', desc: 'Ukrasno bilje', soon: true },
                  { name: 'Klupa', icon: '🪑', desc: 'Drvena klupa', soon: true },
                  { name: 'Drvo', icon: '🌳', desc: 'Listopadno drvo', soon: true },
                  { name: 'Auto', icon: '🚗', desc: 'Parkirano vozilo', soon: true },
                  { name: 'Ograda', icon: '🏗️', desc: 'Drvena ograda', soon: true },
                ].map(obj => (
                  <div
                    key={obj.name}
                    style={{
                      background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                      borderRadius: 12, padding: '14px 12px', cursor: obj.soon ? 'default' : 'pointer',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                      opacity: obj.soon ? 0.5 : 1, position: 'relative',
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                    onMouseEnter={e => { if (!obj.soon) { (e.currentTarget as HTMLDivElement).style.background = 'rgba(99,102,241,0.12)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(99,102,241,0.4)'; } }}
                    onMouseLeave={e => { if (!obj.soon) { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)'; (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.07)'; } }}
                  >
                    <span style={{ fontSize: 28 }}>{obj.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>{obj.name}</span>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>{obj.desc}</span>
                    {obj.soon && (
                      <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 9, fontWeight: 700, color: 'rgba(255,200,50,0.8)', background: 'rgba(255,200,50,0.1)', border: '1px solid rgba(255,200,50,0.2)', borderRadius: 4, padding: '1px 5px', letterSpacing: '0.05em' }}>USKORO</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { 
          from { transform: rotate(0deg) } 
          to { transform: rotate(360deg) } 
        }
        
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.02);
          border-radius: 10px;
          margin: 4px 0;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.08) 100%);
          border-radius: 10px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.12) 100%);
          background-clip: padding-box;
        }
      `}</style>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
