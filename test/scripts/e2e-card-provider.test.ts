import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Frame, Locator } from "playwright";
import { tryFirstVisibleIn } from "#e2e/providers/visible-action.ts";

describe("hosted card fields", () => {
  test("retries when a visible field is not ready for input", async () => {
    let actionCalls = 0;
    const locator = {
      first() {
        return this;
      },
      isVisible: () => Promise.resolve(true),
    } as unknown as Locator;
    const root = {
      locator: () => locator,
    } as unknown as Frame;
    const act = () => {
      actionCalls += 1;
      return actionCalls === 1
        ? Promise.reject(new Error("field detached"))
        : Promise.resolve("filled");
    };

    await expect(
      tryFirstVisibleIn(root, ["#card-number"], act),
    ).resolves.toEqual({ matched: false });
    await expect(
      tryFirstVisibleIn(root, ["#card-number"], act),
    ).resolves.toEqual({ matched: true, value: "filled" });
    expect(actionCalls).toBe(2);
  });

  test("uses the first visible selector", async () => {
    const root = {
      locator: (selector: string) =>
        ({
          first() {
            return this;
          },
          isVisible: () => Promise.resolve(selector === "#ready"),
        }) as unknown as Locator,
    } as unknown as Frame;

    await expect(
      tryFirstVisibleIn(root, ["#hidden", "#ready"], (_locator, selector) =>
        Promise.resolve(selector),
      ),
    ).resolves.toEqual({ matched: true, value: "#ready" });
  });
});
