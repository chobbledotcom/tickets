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

const viewport = { height: 500, width: 1000 };

const events: GuideTimelineEvent[] = [
  { atMs: 0, kind: "cursor", x: 100, y: 100 },
  {
    atMs: 1000,
    kind: "focus",
    rect: { height: 100, width: 200, x: 400, y: 100 },
    scale: 0.5,
    transitionMs: 500,
  },
  { atMs: 2000, kind: "cursor", x: 500, y: 100 },
  { atMs: 2000, kind: "click", x: 500, y: 100 },
  { atMs: 3000, kind: "blur", transitionMs: 500 },
];

describe("guide camera", () => {
  test("turns a page rectangle into a camera position and zoom", () => {
    expect(
      cameraForRect({ height: 100, width: 200, x: 400, y: 100 }, viewport, 0.5),
    ).toEqual({ vignette: 1, x: 0, y: 100, zoom: 2.4 });
    expect(
      cameraForRect({ height: 500, width: 1000, x: 0, y: 0 }, viewport, 0.72),
    ).toEqual({ vignette: 1, x: 0, y: 0, zoom: 1 });
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
    expect(focusRectAt(events, 1000)).toEqual({
      height: 100,
      width: 200,
      x: 400,
      y: 100,
    });
    expect(focusRectAt(events, 3500)).toEqual({
      height: 100,
      width: 200,
      x: 400,
      y: 100,
    });
  });

  test("maps a page point through the camera", () => {
    expect(pageToScreen({ x: 100, y: 200 }, identityCamera, viewport)).toEqual({
      x: 100,
      y: 200,
    });
    expect(
      pageToScreen(
        { x: 500, y: 250 },
        { vignette: 1, x: 0, y: 0, zoom: 2 },
        viewport,
      ),
    ).toEqual({ x: 500, y: 250 });
    expect(
      pageToScreen(
        { x: 600, y: 250 },
        { vignette: 1, x: 0, y: 0, zoom: 2 },
        viewport,
      ),
    ).toEqual({ x: 700, y: 250 });
    expect(
      pageToScreen(
        { x: 500, y: 150 },
        cameraForRect(
          { height: 100, width: 200, x: 400, y: 100 },
          viewport,
          0.5,
        ),
        viewport,
      ),
    ).toEqual({ x: 500, y: 250 });
    expect(
      pageToScreen(
        { x: 600, y: 300 },
        { vignette: 1, x: 0, y: 50, zoom: 2 },
        viewport,
      ),
    ).toEqual({ x: 700, y: 450 });
  });

  test("moves the pointer into the next action and pulses the click", () => {
    expect(cursorStateAt(events, 0)).toEqual({
      pulse: 0,
      visible: true,
      x: 100,
      y: 100,
    });
    expect(cursorStateAt(events, 1840)).toEqual({
      pulse: 0,
      visible: true,
      x: 300,
      y: 100,
    });
    expect(cursorStateAt(events, 2000)).toEqual({
      pulse: 1,
      visible: true,
      x: 500,
      y: 100,
    });
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
