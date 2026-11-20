/**
 * The modal's position arithmetic (`src/ui/client/admin/modal-position.ts`):
 * the clamp that keeps a window on the screen, and the centring that opens it
 * there. A browser is not needed, so the cases are listed directly.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  centredPosition,
  clampModalPosition,
} from "#src/ui/client/admin/modal-position.ts";

const VIEWPORT = { height: 800, width: 1000 };
const SIZE = { height: 200, width: 300 };

/** The nearest point to (`left`, `top`) for a modal of `size`. */
const clamped = (
  left: number,
  top: number,
  size: { height: number; width: number } = SIZE,
): { left: number; top: number } =>
  clampModalPosition({ left, top }, size, VIEWPORT);

describe("the modal position clamp", () => {
  test("leaves a modal that already fits where it is", () => {
    expect(clamped(120, 80)).toEqual({ left: 120, top: 80 });
  });

  test("keeps the modal on the screen at each edge it crosses", () => {
    expect(clamped(-40, -30)).toEqual({ left: 0, top: 0 });
    expect(clamped(900, 700)).toEqual({ left: 700, top: 600 });
    expect(clamped(700, 600)).toEqual({ left: 700, top: 600 });
    // A window the size of the screen sits at the corner.
    expect(clamped(75, 75, VIEWPORT)).toEqual({ left: 0, top: 0 });
  });

  test("keeps an oversized window's title bar and controls reachable", () => {
    // Wider than the screen: the right edge holds the two controls.
    expect(clamped(50, 50, { height: 200, width: 1400 })).toEqual({
      left: -400,
      top: 50,
    });
    // Taller than the screen: the top holds the title bar.
    expect(clamped(50, 50, { height: 1200, width: 300 })).toEqual({
      left: 50,
      top: 0,
    });
  });

  test("centres a window that fits, and keeps an oversized one reachable", () => {
    expect(centredPosition(SIZE, VIEWPORT)).toEqual({ left: 350, top: 300 });
    expect(
      centredPosition({ height: 400, width: 600 }, { height: 300, width: 500 }),
    ).toEqual({ left: -100, top: 0 });
  });
});
