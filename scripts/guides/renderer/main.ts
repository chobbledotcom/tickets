// @ts-types="npm:@types/three@0.180.0"
import * as THREE from "three";
import {
  cameraStateAt,
  cursorStateAt,
  focusRectAt,
  pageToScreen,
} from "#scripts/guides/camera.ts";
import { frameAt, type GuideTimeline } from "#scripts/guides/timeline.ts";

interface RenderResult {
  camera: { vignette: number; x: number; y: number; zoom: number };
  cursor: { pulse: number; visible: boolean; x: number; y: number };
  frame: string;
}

declare global {
  interface Window {
    renderAt: (atMs: number) => Promise<RenderResult>;
    rendererReady: boolean;
  }
}

const canvas = document.getElementById("stage");
const cursorElement = document.getElementById("cursor");
if (!(canvas instanceof HTMLCanvasElement) || !cursorElement) {
  throw new Error("The guide renderer page is incomplete");
}

const timeline: GuideTimeline = await (
  await fetch(new URL("timeline.json", location.href))
).json();
const viewport = timeline.viewport;
const transparent = Reflect.get(globalThis, "__GUIDE_AUTOPLAY__") === true;

const renderer = new THREE.WebGLRenderer({
  alpha: transparent,
  antialias: true,
  canvas,
  preserveDrawingBuffer: true,
});
renderer.setClearColor(0x000000, transparent ? 0 : 1);
renderer.setPixelRatio(1);
renderer.setSize(viewport.width, viewport.height, false);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(
  -viewport.width / 2,
  viewport.width / 2,
  viewport.height / 2,
  -viewport.height / 2,
  -1000,
  1000,
);
camera.position.z = 100;
camera.updateProjectionMatrix();
scene.add(camera);

const viewportPlane = (surface: THREE.Material): THREE.Mesh =>
  new THREE.Mesh(
    new THREE.PlaneGeometry(viewport.width, viewport.height),
    surface,
  );

const material = new THREE.MeshBasicMaterial({ toneMapped: false });
const frameMesh = viewportPlane(material);
scene.add(frameMesh);

const vignette = new THREE.ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  fragmentShader: `
    varying vec2 vUv;
    uniform vec4 uFrameRect;
    uniform vec2 uFocusSize;
    uniform float uStrength;

    float roundedBox(vec2 point, vec2 halfSize, float radius) {
      vec2 q = abs(point) - halfSize + radius;
      return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
    }

    void main() {
      if (
        vUv.x < uFrameRect.x ||
        vUv.x > uFrameRect.x + uFrameRect.z ||
        vUv.y < uFrameRect.y ||
        vUv.y > uFrameRect.y + uFrameRect.w
      ) {
        gl_FragColor = vec4(0.0);
        return;
      }
      vec2 halfSize = uFocusSize * 0.5;
      float radius = min(halfSize.x, halfSize.y) * 0.08;
      float distance = roundedBox(vUv - 0.5, halfSize, radius);
      float outside = smoothstep(0.0, 0.008, distance);
      float border = 1.0 - smoothstep(0.0, 0.008, abs(distance));
      vec3 colour = mix(vec3(0.0), vec3(1.0), border);
      float alpha = outside * uStrength * 0.48 + border * uStrength * 0.85;
      gl_FragColor = vec4(colour, alpha);
    }
  `,
  transparent: true,
  uniforms: {
    uFocusSize: { value: new THREE.Vector2(1, 1) },
    uFrameRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uStrength: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
});
const vignetteMesh = viewportPlane(vignette);
vignetteMesh.position.z = -1;
camera.add(vignetteMesh);

const loader = new THREE.TextureLoader();
const loadTexture = (url: string): Promise<THREE.Texture> => {
  const settled = Promise.withResolvers<THREE.Texture>();
  loader.load(url, settled.resolve, undefined, settled.reject);
  return settled.promise;
};

const sampleCanvas = document.createElement("canvas");
sampleCanvas.width = 1;
sampleCanvas.height = 1;
const sampleContext = sampleCanvas.getContext("2d");
if (!sampleContext) throw new Error("The guide renderer has no 2D context");

/** Keep the space beyond the frame in the page's own background colour. A
 * focus near a page edge can move the frame, and black there reads as a broken
 * video rather than as padding. */
const matchBackground = (texture: THREE.Texture): void => {
  if (transparent) return;
  const image = texture.image;
  if (!(image instanceof HTMLImageElement)) return;
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  sampleContext.drawImage(
    image,
    Math.max(0, Math.floor(width / 2)),
    Math.max(0, height - 1),
    1,
    1,
    0,
    0,
    1,
    1,
  );
  const [red, green, blue] = sampleContext.getImageData(0, 0, 1, 1).data;
  renderer.setClearColor(
    new THREE.Color(red! / 255, green! / 255, blue! / 255),
    1,
  );
};

let showing = "";
const setFrame = async (file: string): Promise<void> => {
  if (file === showing) return;
  const texture = await loadTexture(
    new URL(`frames/${file}`, location.href).href,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  material.map?.dispose();
  material.map = texture;
  material.needsUpdate = true;
  showing = file;
  matchBackground(texture);
};

const placeCursor = (atMs: number, cameraState: RenderResult["camera"]) => {
  const state = cursorStateAt(timeline.events, atMs);
  if (!state.visible) {
    cursorElement.style.opacity = "0";
    return;
  }
  const point = pageToScreen(state, cameraState, viewport);
  const scale =
    canvas.clientWidth === 0 ? 1 : canvas.clientWidth / viewport.width;
  cursorElement.style.opacity = "1";
  cursorElement.style.transform = `translate(${point.x * scale}px, ${point.y * scale}px)`;
  const ring = cursorElement.firstElementChild;
  if (ring instanceof HTMLElement) {
    ring.style.transform = `scale(${1 + state.pulse * 0.8})`;
  }
};

window.renderAt = async (atMs: number): Promise<RenderResult> => {
  const frame = frameAt(timeline.frames, atMs);
  await setFrame(frame.file);
  const state = cameraStateAt(timeline.events, viewport, atMs);
  camera.position.x = state.x;
  camera.position.y = state.y;
  camera.zoom = state.zoom;
  camera.updateProjectionMatrix();

  const frameRect = vignette.uniforms.uFrameRect?.value;
  if (frameRect instanceof THREE.Vector4) {
    frameRect.set(
      0.5 - (0.5 + state.x / viewport.width) * state.zoom,
      0.5 - (0.5 + state.y / viewport.height) * state.zoom,
      state.zoom,
      state.zoom,
    );
  }

  const focus = focusRectAt(timeline.events, atMs);
  const size = vignette.uniforms.uFocusSize?.value;
  if (size instanceof THREE.Vector2 && focus) {
    size.set(
      Math.min(1, (focus.width * state.zoom) / viewport.width),
      Math.min(1, (focus.height * state.zoom) / viewport.height),
    );
  }
  const strength = vignette.uniforms.uStrength;
  if (strength) strength.value = focus ? state.vignette : 0;

  placeCursor(atMs, state);
  renderer.render(scene, camera);
  const cursor = cursorStateAt(timeline.events, atMs);
  return {
    camera: state,
    cursor: {
      pulse: cursor.pulse,
      visible: cursor.visible,
      x: cursor.x,
      y: cursor.y,
    },
    frame: frame.file,
  };
};

/** Play the recorded timeline in a loop. The local render server drives
 * `renderAt` itself, so only the CDN page sets the flag. */
const play = async (): Promise<void> => {
  let started = performance.now();
  while (true) {
    const atMs = performance.now() - started;
    if (atMs >= timeline.durationMs) {
      started = performance.now();
      await window.renderAt(0);
    } else {
      await window.renderAt(atMs);
    }
    await new Promise(requestAnimationFrame);
  }
};

window.rendererReady = true;
if (Reflect.get(globalThis, "__GUIDE_AUTOPLAY__") === true) void play();
