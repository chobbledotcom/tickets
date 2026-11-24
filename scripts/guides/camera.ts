/**
 * The camera is the only moving part of the picture. A focus event names the
 * page rectangle to fill; the renderer turns that into a camera position and a
 * zoom, then eases between keyframes. Keeping this math pure lets the framing
 * be tested without a browser.
 */

import type { GuideRect, GuideTimelineEvent } from "./timeline.ts";

const IDENTITY_ZOOM = 1;
const MAX_FOCUS_ZOOM = 2.4;
const CURSOR_MOVE_MS = 320;
const CLICK_PULSE_MS = 260;

export interface GuideCameraState {
  vignette: number;
  x: number;
  y: number;
  zoom: number;
}

export interface GuideCursorState {
  pulse: number;
  visible: boolean;
  x: number;
  y: number;
}

export const identityCamera: GuideCameraState = {
  vignette: 0,
  x: 0,
  y: 0,
  zoom: IDENTITY_ZOOM,
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const easeInOutCubic = (progress: number): number =>
  progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - (-2 * progress + 2) ** 3 / 2;

/** How far the frame must move and grow to make one page rectangle fill the
 * middle of the output. `scale` below 1 leaves a margin around the target. */
export const cameraForRect = (
  rect: GuideRect,
  viewport: { height: number; width: number },
  scale: number,
): GuideCameraState => {
  if (rect.width <= 0 || rect.height <= 0) {
    throw new Error("A camera focus needs a rectangle with an area");
  }
  return {
    vignette: 1,
    x: rect.x + rect.width / 2 - viewport.width / 2,
    y: -(rect.y + rect.height / 2 - viewport.height / 2),
    zoom: Math.min(
      MAX_FOCUS_ZOOM,
      Math.max(
        1,
        Math.min(viewport.width / rect.width, viewport.height / rect.height) *
          scale,
      ),
    ),
  };
};

const stateAtKeyframe = (
  event: Extract<GuideTimelineEvent, { kind: "focus" | "blur" }>,
  viewport: { height: number; width: number },
): GuideCameraState =>
  event.kind === "focus"
    ? cameraForRect(event.rect, viewport, event.scale)
    : identityCamera;

const lerp = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

interface CameraKeyframe {
  atMs: number;
  state: GuideCameraState;
  transitionMs: number;
}

const cameraKeyframe = (
  atMs: number,
  state: GuideCameraState,
  transitionMs: number,
): CameraKeyframe => ({ atMs, state, transitionMs });

const CAMERA_FIELDS = [
  "vignette",
  "x",
  "y",
  "zoom",
] as const satisfies Readonly<Array<keyof GuideCameraState>>;

const lerpCamera = (
  from: GuideCameraState,
  to: GuideCameraState,
  progress: number,
): GuideCameraState => {
  const state = { ...from };
  for (const field of CAMERA_FIELDS) {
    state[field] = lerp(from[field], to[field], progress);
  }
  return state;
};

/** The camera state at a time. Focus and blur transitions do not overlap in a
 * well-formed storyboard, so the previous keyframe's target is the start. */
export const cameraStateAt = (
  events: readonly GuideTimelineEvent[],
  viewport: { height: number; width: number },
  atMs: number,
): GuideCameraState => {
  const keyframes: CameraKeyframe[] = [cameraKeyframe(0, identityCamera, 0)];
  for (const event of events) {
    if (event.kind !== "focus" && event.kind !== "blur") continue;
    keyframes.push(
      cameraKeyframe(
        event.atMs,
        stateAtKeyframe(event, viewport),
        event.transitionMs,
      ),
    );
  }

  let current = keyframes[0]!;
  for (const keyframe of keyframes) {
    if (keyframe.atMs > atMs) break;
    current = keyframe;
  }
  if (current.transitionMs === 0) return current.state;
  const index = keyframes.indexOf(current);
  const from = index === 0 ? identityCamera : keyframes[index - 1]!.state;
  const progress = easeInOutCubic(
    clamp((atMs - current.atMs) / current.transitionMs, 0, 1),
  );
  return lerpCamera(from, current.state, progress);
};

/** The rectangle the last focus asked for. A blur keeps it, because the
 * vignette fades out rather than jumping to a full-screen hole. */
export const focusRectAt = (
  events: readonly GuideTimelineEvent[],
  atMs: number,
): GuideRect | null => {
  let rect: GuideRect | null = null;
  for (const event of events) {
    if (event.atMs > atMs) break;
    if (event.kind === "focus") rect = event.rect;
  }
  return rect;
};

/** A page point in output pixels, after the camera has zoomed. */
export const pageToScreen = (
  point: { x: number; y: number },
  camera: GuideCameraState,
  viewport: { height: number; width: number },
): { x: number; y: number } => ({
  x:
    (point.x - viewport.width / 2 - camera.x) * camera.zoom +
    viewport.width / 2,
  y:
    viewport.height / 2 +
    (point.y - viewport.height / 2 + camera.y) * camera.zoom,
});

interface CursorPoint {
  atMs: number;
  x: number;
  y: number;
}

const cursorPoints = (events: readonly GuideTimelineEvent[]): CursorPoint[] =>
  events.flatMap((event) =>
    event.kind === "cursor"
      ? [{ atMs: event.atMs, x: event.x, y: event.y }]
      : [],
  );

const clickTimes = (events: readonly GuideTimelineEvent[]): number[] => {
  const times: number[] = [];
  for (const event of events) {
    if (event.kind === "click") times.push(event.atMs);
  }
  return times;
};

/** Where the pointer is, and how bright its click ring is. The pointer eases
 * into the next action, so it arrives at a button exactly as that button is
 * pressed. */
export const cursorStateAt = (
  events: readonly GuideTimelineEvent[],
  atMs: number,
): GuideCursorState => {
  const points = cursorPoints(events);
  if (points.length === 0) return { pulse: 0, visible: false, x: 0, y: 0 };
  let currentIndex = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index]!.atMs > atMs) break;
    currentIndex = index;
  }
  const current = points[currentIndex]!;
  const next = points[currentIndex + 1];
  const to = next ?? current;
  const from = current;
  const moveStart = to.atMs - CURSOR_MOVE_MS;
  const progress = easeInOutCubic(
    next ? clamp((atMs - moveStart) / CURSOR_MOVE_MS, 0, 1) : 1,
  );
  const lastClick = clickTimes(events)
    .filter((time) => time <= atMs)
    .at(-1);
  const pulse =
    lastClick === undefined
      ? 0
      : 1 - clamp((atMs - lastClick) / CLICK_PULSE_MS, 0, 1);
  return {
    pulse,
    visible: atMs >= points[0]!.atMs,
    x: lerp(from.x, to.x, progress),
    y: lerp(from.y, to.y, progress),
  };
};
