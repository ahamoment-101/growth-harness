// Three.js brick-toy minifigures, rendered offscreen into transparent snapshots. The classroom
// layout, stools and interaction stay in the DOM; only the people come from here.
// One hidden renderer is shared, three is loaded on first use, and every snapshot is cached.
import type * as THREE_NS from 'three';
import type { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type Three = typeof THREE_NS;
export type V3 = readonly [number, number, number];
export type Look = { shirt: string; pants: string; hat: 'cap' | 'helmet'; hatColor: string };

/** Seat snapshots cover this box in figure units; the stool top (origin) sits at SEAT_ORIGIN of its height. */
const SEAT_FRAME = { left: -0.62, right: 0.62, top: 1.38, bottom: -0.3 };
export const SEAT_ORIGIN_Y = SEAT_FRAME.top / (SEAT_FRAME.top - SEAT_FRAME.bottom);
export const SEAT_ASPECT = (SEAT_FRAME.top - SEAT_FRAME.bottom) / (SEAT_FRAME.right - SEAT_FRAME.left);
const SEAT_PX = 240;
const MIN_PITCH = 0.42;
const MAX_PITCH = 0.66;
/** A figure turned to face the room is seen nearly level, so the face shows under the cap brim. */
const FACE_PITCH = 0.16;
const PORTRAIT_PX = 400;

/** The floor centre projects to y = 0; the cabinet's depth projects below it in the elevated view. */
const PROP_FRAME = { left: -0.78, right: 0.78, top: 1.44, bottom: -0.42 };
export const PROP_ORIGIN_Y = PROP_FRAME.top / (PROP_FRAME.top - PROP_FRAME.bottom);
export const PROP_ASPECT = (PROP_FRAME.top - PROP_FRAME.bottom) / (PROP_FRAME.right - PROP_FRAME.left);
const PROP_PX = 320;

type Kit = {
  THREE: Three;
  RoundedBox: typeof RoundedBoxGeometry;
  renderer: THREE_NS.WebGLRenderer;
  scene: THREE_NS.Scene;
  /** Printed smiley, shared by every portrait and never disposed. */
  face: THREE_NS.Texture;
};

let kitPromise: Promise<Kit> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<string>>();

function loadKit(): Promise<Kit> {
  kitPromise ??= (async () => {
    const THREE = await import('three');
    const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
    const { RoundedBoxGeometry: RoundedBox } = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral tone mapping keeps the soft pastel colours instead of greying them like ACES.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    scene.add(new THREE.HemisphereLight(0xffffff, 0xc9cde0, 1.05));
    // Key light stays fixed in the room (above, behind the audience, slightly left),
    // so every figure is lit consistently however it is turned.
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-3, 7, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xdfe6ff, 0.7);
    rim.position.set(4, 3, -4);
    scene.add(rim);
    return { THREE, RoundedBox, renderer, scene, face: faceTexture(THREE) };
  })();
  return kitPromise;
}

/** Serialise renders: the shared renderer draws one snapshot at a time. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Draws one figure into a cached snapshot. Each snapshot has one cache key, built by the
 * `*SnapshotKey` function next to it, so callers can tell when the picture they hold is stale.
 */
function snapshot(key: string, draw: (kit: Kit) => { figure: THREE_NS.Group; camera: THREE_NS.Camera; width: number; height: number }): Promise<string> {
  let hit = cache.get(key);
  if (!hit) {
    hit = enqueue(async () => {
      const kit = await loadKit();
      const { renderer, scene } = kit;
      const { figure, camera, width, height } = draw(kit);
      scene.add(figure);
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      scene.remove(figure);
      dispose(figure);
      return url;
    });
    cache.set(key, hit);
  }
  return hit;
}

export const seatSnapshotKey = (id: string, look: Look, yaw: number, view: V3, face: boolean) =>
  `seat|${id}|${JSON.stringify(look)}|${yaw.toFixed(2)}|${view.map((v) => v.toFixed(2)).join(',')}|${face}`;

/** Three-quarter view from where the camera actually sees this seat. `yaw` turns the figure (toward the stage, or round to face the room); `face` prints the smiley. */
export function seatSnapshot(id: string, look: Look, yaw: number, view: V3, face = false): Promise<string> {
  return snapshot(seatSnapshotKey(id, look, yaw, view, face), (kit) => {
    const figure = buildFigure(kit, look, { face });
    figure.rotation.y = yaw;
    const { left, right, top, bottom } = SEAT_FRAME;
    const camera = new kit.THREE.OrthographicCamera(left, right, top, bottom, 0.1, 50);
    // The room camera looks almost straight down on the near rows; flatten the pitch a little
    // so backs and shoulders read instead of just the crowns. Keep the true azimuth.
    const pitch = face ? FACE_PITCH : Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.asin(view[1])));
    const flat = Math.hypot(view[0], view[2]) || 1;
    const dir = [(view[0] / flat) * Math.cos(pitch), Math.sin(pitch), (view[2] / flat) * Math.cos(pitch)];
    camera.position.set(dir[0] * 12, dir[1] * 12, dir[2] * 12);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    return { figure, camera, width: SEAT_PX, height: Math.round(SEAT_PX * SEAT_ASPECT) };
  });
}

export const portraitSnapshotKey = (id: string, look: Look) => `portrait|${id}|${JSON.stringify(look)}`;

/** Front three-quarter bust for the employee card. */
export function portraitSnapshot(id: string, look: Look): Promise<string> {
  return snapshot(portraitSnapshotKey(id, look), (kit) => {
    const figure = buildFigure(kit, look, { item: false, face: true });
    figure.rotation.y = Math.PI + 0.32;
    const camera = new kit.THREE.PerspectiveCamera(19, 1, 0.1, 50);
    camera.position.set(-0.45, 1.4, 3.4);
    camera.lookAt(0, 0.84, 0);
    return { figure, camera, width: PORTRAIT_PX, height: PORTRAIT_PX };
  });
}

export const cabinetSnapshotKey = (view: V3) => `cabinet|${JSON.stringify(PROP_FRAME)}|${view.map((v) => v.toFixed(2)).join(',')}`;

/** The room's filing cabinet, seen from `view` — the unit vector from the cabinet to the room camera. */
export function cabinetSnapshot(view: V3): Promise<string> {
  return snapshot(cabinetSnapshotKey(view), (kit) => {
    const figure = buildCabinet(kit);
    const { left, right, top, bottom } = PROP_FRAME;
    const camera = new kit.THREE.OrthographicCamera(left, right, top, bottom, 0.1, 50);
    camera.position.set(view[0] * 12, view[1] * 12, view[2] * 12);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    return { figure, camera, width: PROP_PX, height: Math.round(PROP_PX * PROP_ASPECT) };
  });
}

/** ABS plastic: a soft, broad highlight, no clearcoat, so it reads as a toy rather than lacquer. */
function plasticMaterial(THREE: Three, color: string, roughness = 0.5) {
  const c = new THREE.Color(color);
  const hsl = c.getHSL({ h: 0, s: 0, l: 0 });
  c.setHSL(hsl.h, hsl.s * SATURATION, hsl.l);
  return new THREE.MeshStandardMaterial({ color: c, roughness, metalness: 0 });
}

/** The same colour, darker by `factor`, for brims and bands. */
function shade(THREE: Three, color: string, factor: number) {
  return '#' + new THREE.Color(color).multiplyScalar(factor).getHexString();
}

function dispose(root: THREE_NS.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE_NS.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((m) => m.dispose());
    }
  });
}

/* ───────── modelling ─────────
   Classic brick-toy minifigure, modelled in millimetres at real proportions and scaled down.
   It sits with its legs on the stool top at the origin and faces −Z (the stage). */

/** Millimetres → figure units; a seated figure in a helmet is about 38mm, 1.3 units, tall. */
const MM = 1 / 29;
/** Head and hat are drawn a little larger than the real toy so they read at seat size. */
const HEAD_SCALE = 1.2;
const YELLOW = '#F2C94C';
/** Every plastic colour keeps this share of its saturation, so the crowd sits softly on the pale room. */
const SATURATION = 0.68;

/** A smiley printed on the front of the head: eyes and a smile on transparent ground. */
function faceTexture(THREE: Three) {
  const canvas = document.createElement('canvas');
  canvas.width = 352;
  canvas.height = 280;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1E1F24';
  ctx.strokeStyle = '#1E1F24';
  for (const x of [0.36, 0.64]) {
    ctx.beginPath();
    ctx.ellipse(canvas.width * x, canvas.height * 0.4, 17, 22, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height * 0.44, 78, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildFigure(kit: Kit, look: Look, opts: { item?: boolean; face?: boolean } = {}) {
  const { THREE, RoundedBox } = kit;
  const g = new THREE.Group();
  g.scale.setScalar(MM);
  const plastic = (color: string, roughness = 0.5) => plasticMaterial(THREE, color, roughness);
  const skin = plastic(YELLOW);
  const shirt = plastic(look.shirt);
  const pants = plastic(look.pants);

  let into: THREE_NS.Group = g;
  const add = (geo: THREE_NS.BufferGeometry, mat: THREE_NS.Material, pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    m.scale.set(...scale);
    into.add(m);
    return m;
  };
  /** Bevelled block centred at `pos`. */
  const block = (w: number, h: number, d: number, mat: THREE_NS.Material, pos: V3, rot: V3 = [0, 0, 0], bevel = 0.6) =>
    add(new RoundedBox(w, h, d, 2, bevel), mat, pos, rot);
  /** A capsule stretched between two points. */
  const limb = (from: V3, to: V3, radius: number, mat: THREE_NS.Material) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, a.distanceTo(b), 8, 16), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(m);
  };

  // Legs bent 90° at the hip, resting on the stool, feet dropping over its front edge.
  for (const s of [-1, 1]) {
    block(7.4, 7, 13, pants, [s * 3.9, 3.5, -3.5]);
    block(7.4, 3, 4.5, pants, [s * 3.9, -0.5, -7.75]);
  }
  block(15.6, 3.2, 8, pants, [0, 8.6, 0], [0, 0, 0], 0.5);

  // Torso: a trapezoid, 15.6 wide at the hips narrowing to 11.6 at the shoulders.
  const torsoGeo = new RoundedBox(15.6, 12, 8, 2, 0.7);
  const pos = torsoGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + 6) / 12;
    pos.setX(i, pos.getX(i) * (1 - 0.26 * t));
  }
  torsoGeo.computeVertexNormals();
  add(torsoGeo, shirt, [0, 16.2, 0]);
  add(new THREE.CylinderGeometry(2.9, 2.9, 1.6, 24), skin, [0, 23, 0]);

  // Arms swing forward from the shoulders; C-shaped hands meet in front of the chest.
  for (const s of [-1, 1]) {
    add(new THREE.SphereGeometry(2.5, 24, 16), shirt, [s * 7, 20.2, 0]);
    limb([s * 7.2, 20, 0], [s * 7.8, 14.6, -3], 2.3, shirt);
    limb([s * 7.8, 14.6, -3], [s * 6.4, 13.6, -8.2], 2.1, shirt);
    add(new THREE.CylinderGeometry(1.2, 1.2, 2, 12), skin, [s * 6, 13.5, -9.6], [Math.PI / 2, 0, 0]);
    add(new THREE.TorusGeometry(1.9, 0.95, 12, 24, Math.PI * 1.6), skin, [s * 5.7, 13.6, -11.4], [0, Math.PI / 2, Math.PI * 0.4]);
  }
  if (opts.item !== false) {
    block(12, 9, 0.9, plastic('#4A4F5A', 0.4), [0, 16.4, -12.6], [-0.45, 0, 0], 0.4);
  }

  // Head: a cylinder with rounded top and bottom edges, built in its own group on the neck.
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 23.8, 0);
  headGroup.scale.setScalar(HEAD_SCALE);
  g.add(headGroup);
  into = headGroup;
  const headY = 0;
  const R = 4.9;
  const profile: THREE_NS.Vector2[] = [new THREE.Vector2(0, 0)];
  for (let i = 0; i <= 4; i++) { const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2); profile.push(new THREE.Vector2(R - 0.9 + Math.cos(a) * 0.9, 0.9 + Math.sin(a) * 0.9)); }
  for (let i = 0; i <= 4; i++) { const a = (i / 4) * (Math.PI / 2); profile.push(new THREE.Vector2(R - 0.9 + Math.cos(a) * 0.9, 7.9 + Math.sin(a) * 0.9)); }
  profile.push(new THREE.Vector2(0, 8.8));
  add(new THREE.LatheGeometry(profile, 40), skin, [0, headY, 0]);
  if (opts.face) {
    // A decal wrapped on the front arc of the head (θ = π faces −Z).
    const arc = 1.8;
    const decal = new THREE.MeshStandardMaterial({ map: kit.face, transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 });
    add(new THREE.CylinderGeometry(R + 0.03, R + 0.03, (R * arc * 280) / 352, 24, 1, true, Math.PI - arc / 2, arc), decal, [0, headY + 3.4, 0]);
  }

  // Hat: every figure wears one.
  const hat = plastic(look.hatColor, 0.45);
  const hatShade = plastic(shade(THREE, look.hatColor, 0.9), 0.45);
  const dome = (radius: number, y: number, scaleY: number) =>
    add(new THREE.SphereGeometry(radius, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), hat, [0, y, 0], [0, 0, 0], [1, scaleY, 1]);
  if (look.hat === 'cap') {
    dome(5.5, headY + 7, 0.9);
    add(new THREE.CylinderGeometry(5.5, 5.5, 1, 40), hat, [0, headY + 6.5, 0]);
    // Peak over the face.
    add(new THREE.CylinderGeometry(4, 4, 0.8, 32, 1, false, Math.PI / 2, Math.PI), hatShade, [0, headY + 6.3, -4.6], [0.08, 0, 0], [1, 1, 1.25]);
    add(new THREE.SphereGeometry(0.9, 16, 10), hatShade, [0, headY + 12, 0]);
  } else {
    // Construction helmet: dome, flared rim and a ridge running front to back.
    dome(5.7, headY + 6.8, 0.95);
    add(new THREE.CylinderGeometry(5.7, 6.8, 0.9, 40), hat, [0, headY + 6.5, 0]);
    add(new THREE.TorusGeometry(5.5, 0.75, 10, 32, Math.PI), hatShade, [0, headY + 6.8, 0], [0, Math.PI / 2, 0], [1, 0.97, 1]);
  }

  return g;
}

/* ───────── room props ─────────
   Built from the same bevelled blocks and plastic as the figures, in the same millimetres,
   so an object of the room reads as part of the same toy set. */

function buildCabinet({ THREE, RoundedBox }: Kit) {
  const g = new THREE.Group();
  g.scale.setScalar(MM);
  const block = (w: number, h: number, d: number, color: string, pos: V3, bevel = 0.9, rotY = 0) => {
    const m = new THREE.Mesh(new RoundedBox(w, h, d, 2, bevel), plasticMaterial(THREE, color, 0.5));
    m.position.set(...pos);
    m.rotation.y = rotY;
    g.add(m);
    return m;
  };

  const BODY = '#EFF1F5';
  const DRAWER = '#93A6E8';
  const PULL = '#5E6AD2';
  // The cabinet stands on a low plinth, like the stage does, and carries a lipped top.
  block(26, 3, 19, '#C4CBDC', [0, 1.5, 0], 0.6);
  block(30, 28, 22, BODY, [0, 17, 0]);
  block(31.5, 2.8, 23.5, '#DDE2ED', [0, 32.4, 0], 0.7);

  // Two drawer fronts proud of the body, each with a recessed pull. Front is +Z, toward the room.
  for (const y of [24.2, 12.2]) {
    block(25, 10.4, 1.8, DRAWER, [0, y, 11.2], 0.5);
    block(8, 1.5, 1.4, PULL, [0, y + 1.4, 12.2], 0.5);
  }

  // What the cabinet is for, stacked on top: a run of papers under one folder.
  block(13, 2.2, 9.5, '#FDFDFB', [1.5, 34.9, 0.5], 0.35, 0.2);
  block(11, 1.4, 8, '#F6CF6B', [-0.5, 36.7, -0.5], 0.35, -0.28);
  return g;
}
