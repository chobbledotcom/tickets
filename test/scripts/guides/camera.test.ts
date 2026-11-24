import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  cameraForRect,
  cameraStateAt,
  cursorStateAt,
  easeInOutCubic,
  focusRectAt,
  identityCamera,
  pageToScreen,
} from "#scripts/guides/camera.ts";
import type { GuideTimelineEvent } from "#scripts/guides/timeline.ts";
import { focusEvent, pointerEvent } from "./fixtures.ts";

const viewport = { height: 500, width: 1000 };
const focusRect = { height: 100, width: 200, x: 400, y: 100 };
const zoomTwice = (y: number) => ({ vignette: 1, x: 0, y, zoom: 2 });

const events: GuideTimelineEvent[] = [
  pointerEvent("cursor", 0, 100, 100),
  focusEvent(1000, focusRect, 0.5, 500),
  pointerEvent("cursor", 2000, 500, 100),
  pointerEvent("click", 2000, 500, 100),
  { atMs: 3000, kind: "blur", transitionMs: 500 },
];

describe("guide camera", () => {
  test("turns a page rectangle into a camera position and zoom", () => {
    expect([
      cameraForRect(focusRect, viewport, 0.5),
      cameraForRect({ ...viewport, x: 0, y: 0 }, viewport, 0.72),
    ]).toEqual([
      { vignette: 1, x: 0, y: 100, zoom: 2.4 },
      { vignette: 1, x: 0, y: 0, zoom: 1 },
    ]);
    const nearEdge = cameraForRect(
      { height: 40, width: 200, x: 400, y: 450 },
      viewport,
      0.5,
    );
    expect(pageToScreen({ x: 500, y: 470 }, nearEdge, viewport)).toEqual({
      x: 500,
      y: 250,
    });
  });

  test("stays still before the first keyframe and eases to its target", () => {
    expect(cameraStateAt(events, viewport, 0)).toEqual(identityCamera);
    expect(cameraStateAt(events, viewport, 1000)).toEqual(identityCamera);
    const halfway = cameraStateAt(events, viewport, 1250);
    expect(halfway.zoom).toBeCloseTo(1.7, 6);
    expect(halfway.y).toBeCloseTo(50, 6);
    expect(cameraStateAt(events, viewport, 1500)).toEqual({
      vignette: 1,
      x: 0,
      y: 100,
      zoom: 2.4,
    });
  });

  test("returns to the whole page after a blur", () => {
    expect(cameraStateAt(events, viewport, 3250).zoom).toBeCloseTo(1.7, 6);
    expect(cameraStateAt(events, viewport, 3500)).toEqual(identityCamera);
  });

  test("keeps the focused rectangle through a blur fade", () => {
    expect(focusRectAt(events, 500)).toBeNull();
    expect(focusRectAt(events, 1000)).toEqual(focusRect);
    expect(focusRectAt(events, 3500)).toEqual(focusRect);
  });

  test("maps a page point through the camera", () => {
    const cases = [
      [100, 200, identityCamera, 100, 200],
      [500, 250, zoomTwice(0), 500, 250],
      [600, 250, zoomTwice(0), 700, 250],
      [500, 150, cameraForRect(focusRect, viewport, 0.5), 500, 250],
      [600, 300, zoomTwice(50), 700, 450],
    ] as const;
    for (const [x, y, camera, screenX, screenY] of cases) {
      expect(pageToScreen({ x, y }, camera, viewport)).toEqual({
        x: screenX,
        y: screenY,
      });
    }
  });

  test("moves the pointer into the next action and pulses the click", () => {
    const visibleAt = (pulse: number, x: number) => ({
      pulse,
      visible: true,
      x,
      y: 100,
    });
    expect([0, 1840, 2000].map((atMs) => cursorStateAt(events, atMs))).toEqual([
      visibleAt(0, 100),
      visibleAt(0, 300),
      visibleAt(1, 500),
    ]);
    expect(cursorStateAt(events, 2130).pulse).toBeCloseTo(0.5, 6);
    expect(cursorStateAt([], 100)).toEqual({
      pulse: 0,
      visible: false,
      x: 0,
      y: 0,
    });
  });

  test("uses an S curve and rejects a focus without an area", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(1)).toBe(1);
    expect(() =>
      cameraForRect({ height: 0, width: 20, x: 0, y: 0 }, viewport, 1),
    ).toThrow("area");
  });
});
