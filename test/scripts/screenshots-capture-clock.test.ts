import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { installLayerCaptureClock } from "#scripts/screenshots/capture.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";

const globals = createGlobalStash();

describe("installLayerCaptureClock", () => {
  afterEach(() => globals.restore());

  test("holds page callbacks while layer captures are frozen", async () => {
    let intervalCallback: unknown;
    let timeoutCallback: unknown;
    let frameCallback: unknown;
    const nativeCalls: unknown[][] = [];
    globals.set("setInterval", (callback: unknown, ...args: unknown[]) => {
      intervalCallback = callback;
      nativeCalls.push(["interval", ...args]);
      return 1;
    });
    globals.set("setTimeout", (callback: unknown, ...args: unknown[]) => {
      timeoutCallback = callback;
      nativeCalls.push(["timeout", callback, ...args]);
      return 2;
    });
    globals.set("requestAnimationFrame", (callback: unknown) => {
      frameCallback = callback;
      return 3;
    });
    let installs = 0;
    const page = {
      addInitScript: (script: () => void) => {
        script();
        return Promise.resolve();
      },
      clock: {
        install: () => {
          installs += 1;
          return Promise.resolve();
        },
      },
    } as never;

    await installLayerCaptureClock(page);
    expect(installs).toBe(1);

    const intervalRuns: unknown[] = [];
    setInterval((value) => intervalRuns.push(value), 10, "ready");
    if (typeof intervalCallback !== "function") {
      throw new Error("Interval callback was not installed.");
    }
    Reflect.apply(intervalCallback, globalThis, ["ready"]);
    expect(intervalRuns).toEqual(["ready"]);

    Reflect.apply(Reflect.get(globalThis, "setTimeout"), globalThis, [
      "literal callback",
      5,
    ]);
    expect(nativeCalls.at(-1)).toEqual(["timeout", "literal callback", 5]);

    const setFrozen = Reflect.get(globalThis, "__setLayerCaptureFrozen");
    if (typeof setFrozen !== "function") {
      throw new Error("Layer capture controls were not installed.");
    }
    Reflect.apply(setFrozen, globalThis, [true]);

    let timeoutRuns = 0;
    setTimeout(() => {
      timeoutRuns += 1;
    }, 20);
    if (typeof timeoutCallback !== "function") {
      throw new Error("Timeout callback was not installed.");
    }
    Reflect.apply(timeoutCallback, globalThis, []);
    Reflect.apply(intervalCallback, globalThis, ["frozen"]);

    let frameTime = 0;
    requestAnimationFrame((time) => {
      frameTime = time;
    });
    if (typeof frameCallback !== "function") {
      throw new Error("Animation frame callback was not installed.");
    }
    Reflect.apply(frameCallback, globalThis, [25]);
    expect(intervalRuns).toEqual(["ready"]);
    expect(timeoutRuns).toBe(0);
    expect(frameTime).toBe(0);

    Reflect.apply(setFrozen, globalThis, [false]);
    await Promise.resolve();
    expect(timeoutRuns).toBe(1);

    requestAnimationFrame((time) => {
      frameTime = time;
    });
    if (typeof frameCallback !== "function") {
      throw new Error("Animation frame callback was not installed.");
    }
    Reflect.apply(frameCallback, globalThis, [50]);
    expect(frameTime).toBe(50);
  });

  test("fails when the browser has no animation frame method", async () => {
    globals.set("requestAnimationFrame", undefined);
    const page = {
      addInitScript: (script: () => void) => Promise.resolve(script()),
      clock: { install: () => Promise.resolve() },
    } as never;

    await expect(installLayerCaptureClock(page)).rejects.toThrow(
      "Missing browser method: requestAnimationFrame",
    );
  });
});
