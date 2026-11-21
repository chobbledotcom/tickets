import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type FocusFacts,
  focusDomain,
  focusEvents,
  focusFacts,
  focusSnapshot,
  modalFocusModelData,
  stuckFocusData,
  stuckFocusFacts,
  twoBrightFocusData,
  twoBrightFocusFacts,
} from "#scripts/verify-models/modal-focus.ts";
import { modalTargets } from "#scripts/verify-models/modal-lifecycle-matrix.ts";
import { VERIFICATION_MODULES } from "#scripts/verify-models/registry.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  EMPTY_SCREEN,
  type ModalFocus,
  transitionScreen,
} from "#src/ui/client/admin/modal-focus.ts";

const OPEN = { a: 0, b: 1, c: 2 };
const RAISE = { a: 3, b: 4, c: 5 };
const CLOSE = { a: 6, b: 7, c: 8 };
const PRESS = 9;

const facts = focusFacts();

/** The id of the declared screen with these windows, bottom first. */
const screenId = (focus: ModalFocus, ...keys: string[]): number => {
  const id = focusDomain.findIndex(
    (screen) =>
      screen.focus === focus &&
      screen.windows.map(({ key }) => key).join() === keys.join(),
  );
  if (id < 0) throw new Error(`No declared screen: ${focus} ${keys.join()}`);
  return id;
};

/** The id of the screen that the event reaches from the source screen. */
const reached = (source: number, event: number): number =>
  requireValue(
    facts.edges.find((edge) => edge.source === source && edge.event === event),
    "No observed edge",
  ).target;

const differing = <Row>(clean: readonly Row[], corrupted: readonly Row[]) =>
  corrupted.filter(
    (row, index) => JSON.stringify(row) !== JSON.stringify(clean[index]),
  );

describe("modal focus production facts", () => {
  test("declares every screen and every event, including unchanged outcomes", () => {
    // The empty screen, and 15 stacks of windows with two holders of the focus.
    expect(facts.snapshots).toHaveLength(31);
    expect(focusEvents).toHaveLength(10);
    expect(facts.edges).toHaveLength(31 * 10);
    expect(facts.snapshots.map((row) => row.id)).toEqual(
      focusDomain.map((_, id) => id),
    );
    expect(facts.events.map((row) => row.kind)).toEqual([
      "open",
      "open",
      "open",
      "raise",
      "raise",
      "raise",
      "close",
      "close",
      "close",
      "focus-page",
    ]);
    expect(facts.events[PRESS]?.key).toBe("page");
    expect(modalTargets(facts)).toHaveLength(31);
  });

  test("reaches every declared screen from the empty screen", () => {
    const reachedIds = new Set([0]);
    for (let size = 0; size !== reachedIds.size; ) {
      size = reachedIds.size;
      for (const edge of facts.edges) {
        if (reachedIds.has(edge.source)) reachedIds.add(edge.target);
      }
    }
    expect(reachedIds).toEqual(new Set(focusDomain.map((_, id) => id)));
    expect(focusDomain[0]).toBe(EMPTY_SCREEN);
  });

  test("every edge links an actual reducer result to its declared screen", () => {
    for (const edge of facts.edges) {
      const observed = transitionScreen(
        requireValue(focusDomain[edge.source], "Missing source screen"),
        requireValue(focusEvents[edge.event], "Missing event"),
      );
      expect(focusSnapshot(observed)).toEqual(
        focusSnapshot(
          requireValue(focusDomain[edge.target], "Missing target screen"),
        ),
      );
    }
  });

  test("an open or a raise gives a window the focus", () => {
    const empty = screenId("page");
    expect(reached(empty, OPEN.a)).toBe(screenId("window", "a"));
    // A raise and a second open both bring the window to the top.
    expect(reached(screenId("page", "a", "b"), RAISE.a)).toBe(
      screenId("window", "b", "a"),
    );
    expect(reached(screenId("page", "a", "b"), OPEN.a)).toBe(
      screenId("window", "b", "a"),
    );
    // A raise of a window that is not open changes nothing.
    expect(reached(screenId("page", "a"), RAISE.c)).toBe(screenId("page", "a"));
  });

  test("a press on the page gives the page the focus and moves no window", () => {
    expect(reached(screenId("window", "a", "b"), PRESS)).toBe(
      screenId("page", "a", "b"),
    );
    expect(reached(screenId("page", "a", "b"), PRESS)).toBe(
      screenId("page", "a", "b"),
    );
    expect(reached(screenId("page"), PRESS)).toBe(screenId("page"));
  });

  test("a close keeps the focus, until the last window closes", () => {
    expect(reached(screenId("window", "a", "b"), CLOSE.b)).toBe(
      screenId("window", "a"),
    );
    expect(reached(screenId("page", "a", "b"), CLOSE.b)).toBe(
      screenId("page", "a"),
    );
    expect(reached(screenId("window", "a"), CLOSE.a)).toBe(screenId("page"));
  });

  test("a producer fault reaches the facts, and an outside screen is refused", () => {
    const stuck = focusFacts((screen, event) =>
      event.type === "focus-page" ? screen : transitionScreen(screen, event),
    );
    const id = screenId("window", "a");
    expect(
      requireValue(
        stuck.edges.find((edge) => edge.source === id && edge.event === PRESS),
        "No press edge",
      ).target,
    ).toBe(id);
    expect(() =>
      focusFacts(() => ({ focus: "window", windows: [] })),
    ).toThrow("does not hold an observed screen");
    expect(() =>
      focusFacts(() => ({
        focus: "window",
        windows: [
          { expandedPoint: null, key: "d", point: { left: 0, top: 0 } },
        ],
      })),
    ).toThrow("Unknown window identity");
  });

  test("the bright control corrupts exactly one dim flag and no edge", () => {
    const corrupted: FocusFacts = twoBrightFocusFacts(facts);
    expect(corrupted.edges).toEqual(facts.edges);
    expect(differing(facts.snapshots, corrupted.snapshots)).toEqual([
      {
        ...requireValue(
          facts.snapshots[screenId("window", "a", "b")],
          "Missing two-window row",
        ),
        aDim: 0,
      },
    ]);
  });

  test("the focus control corrupts exactly one press and keeps its target declared", () => {
    const corrupted = stuckFocusFacts(facts);
    const id = screenId("window", "a");
    expect(corrupted.snapshots).toEqual(facts.snapshots);
    expect(differing(facts.edges, corrupted.edges)).toEqual([
      { event: PRESS, source: id, target: id },
    ]);
  });

  test("registration loads the lazy model and every control", async () => {
    const registered = requireValue(
      VERIFICATION_MODULES.find(({ module }) => module === "ModalFocus"),
      "ModalFocus is not registered",
    );
    if (registered.kind !== "model") throw new Error("ModalFocus is a model");
    const clean = await modalFocusModelData();
    expect(clean).toContain("MODULE ModalFocusData");
    expect(await registered.data()).toEqual(clean);
    expect(registered.controls.map(({ phase }) => phase)).toEqual([
      "initial",
      "step",
    ]);
    const sources = [await twoBrightFocusData(), await stuckFocusData()];
    for (const [index, control] of registered.controls.entries()) {
      expect(await control.data()).toEqual(sources[index]);
    }
  });
});
