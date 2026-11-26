import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  GUEST_KEY_PREFIXES,
  isStoreBlocked,
  isStoreFull,
  MODE_KEY_PREFIX,
  QUEUE_KEY,
  TICKETS_KEY_PREFIX,
  withStoreOr,
} from "#src/ui/client/scanner-storage.ts";
import { createDomInstaller, whileStoreThrows } from "#test-utils/happy-dom.ts";

const dom = createDomInstaller(["localStorage"]);

describe("scanner storage", () => {
  afterEach(async () => {
    await dom.cleanup();
  });

  test("names the keys that hold guests apart from the queue", () => {
    expect(GUEST_KEY_PREFIXES).toEqual([TICKETS_KEY_PREFIX, MODE_KEY_PREFIX]);
    expect([TICKETS_KEY_PREFIX, MODE_KEY_PREFIX, QUEUE_KEY]).toEqual([
      "scanner-tickets-",
      "scanner-offline-mode-",
      "scanner-queue",
    ]);
  });

  test("tells the browser's two store refusals apart", () => {
    const full = new DOMException("full", "QuotaExceededError");
    const blocked = new DOMException("blocked", "SecurityError");
    expect([isStoreFull(full), isStoreFull(blocked)]).toEqual([true, false]);
    expect([isStoreBlocked(blocked), isStoreBlocked(full)]).toEqual([
      true,
      false,
    ]);
    // A plain error with the same name is not the browser's refusal.
    const named = Object.assign(new Error("full"), {
      name: "QuotaExceededError",
    });
    expect(isStoreFull(named)).toBe(false);
  });

  test("runs on the page's store, or answers the blocked value", () => {
    const window = dom.installDom("");
    window.localStorage.setItem(QUEUE_KEY, "[]");

    expect(withStoreOr((store) => store.getItem(QUEUE_KEY), null)).toBe("[]");
    expect(
      whileStoreThrows(new DOMException("blocked", "SecurityError"), () =>
        withStoreOr((store) => store.getItem(QUEUE_KEY), "blocked"),
      ),
    ).toBe("blocked");
  });

  test("lets any other store fault through", () => {
    dom.installDom("");
    expect(() =>
      whileStoreThrows(new Error("The store broke"), () =>
        withStoreOr((store) => store.getItem(QUEUE_KEY), null),
      ),
    ).toThrow("The store broke");
  });
});
