import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ModalEvent,
  type ModalState,
  transitionModals,
} from "#src/ui/client/admin/modal-state.ts";

const size = { height: 100, width: 200 };
const viewport = { height: 400, width: 600 };
const a: ModalState = Object.freeze({
  expandedPoint: null,
  key: "a",
  point: Object.freeze({ left: 350, top: 250 }),
});
const b: ModalState = Object.freeze({
  expandedPoint: null,
  key: "b",
  point: Object.freeze({ left: 20, top: 30 }),
});
const c: ModalState = {
  expandedPoint: null,
  key: "c",
  point: { left: 10, top: 15 },
};
const stack = Object.freeze([a, b, c]);
const keys = (states: readonly ModalState[]) =>
  states.map((state) => state.key);

const restore: ModalEvent = { key: "a", size, type: "restore", viewport };
const move: ModalEvent = {
  key: "a",
  point: { left: -100, top: 900 },
  size,
  type: "move",
  viewport,
};

describe("pure modal lifecycle", () => {
  test("appends a new key and duplicate open raises the unchanged instance", () => {
    expect(
      transitionModals([], { key: "a", point: a.point, type: "open" }),
    ).toEqual([a]);
    const raised = transitionModals(stack, {
      key: "a",
      point: { left: 999, top: 999 },
      type: "open",
    });
    expect(keys(raised)).toEqual(["b", "c", "a"]);
    expect(raised[2]).toBe(a);
    expect(raised[0]).toBe(b);
    expect(stack).toEqual([a, b, c]);
  });

  test("raises without changing relative order and keeps already-top identity", () => {
    expect(keys(transitionModals(stack, { key: "b", type: "raise" }))).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(transitionModals(stack, { key: "c", type: "raise" })).toBe(stack);
    expect(
      transitionModals(stack, { key: "c", point: a.point, type: "open" }),
    ).toBe(stack);
  });

  test("close removes only its key; reopening creates a fresh expanded state", () => {
    const closed = transitionModals(stack, { key: "b", type: "close" });
    expect(closed).toEqual([a, c]);
    expect(closed[0]).toBe(a);
    const reopened = transitionModals(closed, {
      key: "b",
      point: a.point,
      type: "open",
    });
    expect(keys(reopened)).toEqual(["a", "c", "b"]);
    expect(reopened[2]).toEqual({ ...b, point: a.point });
    expect(reopened[2]).not.toBe(b);
  });

  test("all non-open events for a closed key are harmless queued events", () => {
    const events: ModalEvent[] = [
      { key: "a", type: "raise" },
      { key: "a", type: "close" },
      { key: "a", type: "minimise" },
      restore,
      move,
    ];
    for (const event of events) expect(transitionModals([], event)).toEqual([]);
    const closed = transitionModals(stack, { key: "a", type: "close" });
    for (const event of events)
      expect(transitionModals(closed, event)).toBe(closed);
  });

  test("minimise saves once, collapsed drag preserves it, restore uses it", () => {
    const minimised = transitionModals(stack, { key: "a", type: "minimise" });
    expect(minimised[0]!.expandedPoint).toBe(a.point);
    expect(minimised[1]).toBe(b);
    expect(transitionModals(minimised, { key: "a", type: "minimise" })).toBe(
      minimised,
    );
    const dragged = transitionModals(minimised, move);
    expect(dragged[0]).toEqual({
      ...a,
      expandedPoint: a.point,
      point: { left: 0, top: 300 },
    });
    expect(transitionModals(dragged, { key: "a", type: "minimise" })).toBe(
      dragged,
    );
    const restored = transitionModals(dragged, restore);
    expect(restored).toEqual(stack);
    expect(transitionModals(restored, restore)).toBe(restored);
  });

  test("restore clamps saved coordinates against the new measured viewport", () => {
    const minimised = transitionModals(stack, { key: "a", type: "minimise" });
    const restored = transitionModals(minimised, {
      ...restore,
      viewport: { height: 180, width: 300 },
    });
    expect(restored[0]).toEqual({ ...a, point: { left: 100, top: 80 } });
    expect(keys(restored)).toEqual(keys(stack));
  });

  test("moves clamp independently on both axes and keep oversized controls reachable", () => {
    const moved = transitionModals(stack, move);
    expect(moved[0]!.point).toEqual({ left: 0, top: 300 });
    expect(moved[1]).toBe(b);
    expect(transitionModals(moved, move)).toBe(moved);
    const oversized = transitionModals(stack, {
      ...move,
      point: { left: 80, top: -20 },
      size: { height: 700, width: 900 },
    });
    expect(oversized[0]!.point).toEqual({ left: -300, top: 0 });
  });

  test("resize clamps every measured current point, but retains saved restore points", () => {
    const minimised = transitionModals([a, b], { key: "a", type: "minimise" });
    const resized = transitionModals(minimised, {
      sizes: new Map([
        ["a", { height: 40, width: 100 }],
        ["b", { height: 170, width: 290 }],
      ]),
      type: "resize",
      viewport: { height: 180, width: 300 },
    });
    expect(resized).toEqual([
      { ...a, expandedPoint: a.point, point: { left: 200, top: 140 } },
      { ...b, point: { left: 10, top: 10 } },
    ]);
    expect(transitionModals(resized, restore)[0]).toEqual(a);
    const unchanged = transitionModals(stack, {
      sizes: new Map(stack.map((state) => [state.key, size])),
      type: "resize",
      viewport,
    });
    expect(unchanged).toBe(stack);
    expect(
      transitionModals([], { sizes: new Map(), type: "resize", viewport }),
    ).toEqual([]);
  });

  test("resize rejects a missing measurement instead of leaving a live window unclamped", () => {
    expect(() =>
      transitionModals(stack, {
        sizes: new Map([["a", size]]),
        type: "resize",
        viewport,
      }),
    ).toThrow("Missing modal size: b");
    expect(stack).toEqual([a, b, c]);
  });
});
