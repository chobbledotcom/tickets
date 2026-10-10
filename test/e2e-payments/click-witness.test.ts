/**
 * The click witness, against fake controls: a stamping evaluate that arms the
 * page-side listener, and a read-back that answers whether the click may have
 * dispatched. Replay safety is what the harness stakes on the witness, so
 * every branch it carries is exercised here in-process.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Locator } from "playwright";
import { armWitnessedAttempt, interactable } from "#e2e/click-witness.ts";

/** The page-side shape the witness stamps onto a control. */
type FakeElement = {
  seen?: boolean;
  clickListeners: (() => void)[];
  addEventListener: (type: string, listener: () => void) => void;
};

const fakeElement = (): FakeElement => {
  const element: FakeElement = {
    addEventListener: (_type, listener) => {
      element.clickListeners.push(listener);
    },
    clickListeners: [],
  };
  return element;
};

/** Simulate the visitor's click: the page-side listener marks the element. */
const click = (element: FakeElement): void => {
  for (const listener of element.clickListeners) listener();
};

/** A locator whose evaluate calls follow a script: each step either runs the
 * page-side function against the element, or fails like a vanished document. */
const scriptedLocator = (
  element: FakeElement,
  steps: readonly { fail?: boolean }[],
  visible = true,
  enabled = true,
): Locator => {
  const queue = [...steps];
  return {
    evaluate: (fn: (el: unknown) => unknown) => {
      const step = queue.shift();
      if (step === undefined || step.fail) {
        return Promise.reject(new Error("the document is gone"));
      }
      return Promise.resolve(fn(element));
    },
    isEnabled: () => Promise.resolve(enabled),
    isVisible: () => Promise.resolve(visible),
  } as unknown as Locator;
};

describe("interactable", () => {
  test("a visible, enabled control can be acted on", async () => {
    expect(await interactable(scriptedLocator(fakeElement(), []))).toBe(true);
  });

  test("a disabled control cannot be acted on", async () => {
    expect(
      await interactable(scriptedLocator(fakeElement(), [], true, false)),
    ).toBe(false);
  });

  test("an invisible control cannot be acted on", async () => {
    expect(await interactable(scriptedLocator(fakeElement(), [], false))).toBe(
      false,
    );
  });
});

describe("armWitnessedAttempt", () => {
  test("a finished ordinary action reports success and is not replayed", async () => {
    const attempt = await armWitnessedAttempt(
      scriptedLocator(fakeElement(), [{}, {}]),
    );
    let acted = 0;
    expect(
      await attempt(() => {
        acted += 1;
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(acted).toBe(1);
  });

  test("a click the witness saw is never replayed", async () => {
    const element = fakeElement();
    const attempt = await armWitnessedAttempt(
      scriptedLocator(element, [{}, {}]),
    );
    const failure = new Error("the ordinary action failed");
    await expect(
      attempt(() => {
        click(element);
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
  });

  test("an undispatched click on a live control replays exactly once", async () => {
    const element = fakeElement();
    const attempt = await armWitnessedAttempt(
      scriptedLocator(element, [{}, {}]),
    );
    let acted = 0;
    const ordinary = () => {
      acted += 1;
      return Promise.reject(new Error("the pointer wait gave up"));
    };
    expect(await attempt(ordinary)).toBe(false);
    expect(acted).toBe(1);
  });

  test("an undispatched click on a control that is gone rethrows", async () => {
    const element = fakeElement();
    const attempt = await armWitnessedAttempt(
      scriptedLocator(element, [{}, {}], false),
    );
    const failure = new Error("the pointer wait gave up");
    await expect(attempt(() => Promise.reject(failure))).rejects.toBe(failure);
  });

  test("a witness that could not arm answers may-have-dispatched", async () => {
    const attempt = await armWitnessedAttempt(
      scriptedLocator(fakeElement(), [{ fail: true }]),
    );
    const failure = new Error("the pointer wait gave up");
    await expect(attempt(() => Promise.reject(failure))).rejects.toBe(failure);
  });

  test("a read-back that fails answers may-have-dispatched", async () => {
    const element = fakeElement();
    const attempt = await armWitnessedAttempt(
      scriptedLocator(element, [{}, { fail: true }]),
    );
    const failure = new Error("the pointer wait gave up");
    await expect(attempt(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});
