import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initLogoutDataClear } from "#src/ui/client/admin/logout-data-clear.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const dom = createDomInstaller(["localStorage"]);

/** The scanner storage of two doors, and a queue. */
const SEEDED: Record<string, string> = {
  "scanner-offline-mode-/admin/listing/9/scan": "1",
  "scanner-queue": "[]",
  "scanner-tickets-/admin/groups/5/scan": "list-5",
  "scanner-tickets-/admin/listing/9/scan": "list-9",
};

/** Install `html` with the seeded store, run the clear, and answer what the
 * store holds after it. */
const storeAfterClear = (html: string): Record<string, string> => {
  const window = dom.installDom(html);
  for (const [key, value] of Object.entries(SEEDED)) {
    window.localStorage.setItem(key, value);
  }
  initLogoutDataClear();
  return Object.fromEntries(
    Object.keys(window.localStorage).map((key) => [
      key,
      String(window.localStorage.getItem(key)),
    ]),
  );
};

/** Install the login page with one saved list, and make reading the store
 * throw `error`. Answers the clear to run, which restores the store after
 * it runs. */
const clearWhileStoreThrows = (error: Error): (() => void) => {
  const window = dom.installDom("<div data-clears-scanner-storage></div>");
  window.localStorage.setItem("scanner-tickets-/admin/listing/9/scan", "list");
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  if (descriptor === undefined) throw new Error("No localStorage to block");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw error;
    },
  });
  return () => {
    try {
      initLogoutDataClear();
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  };
};

describe("logout data clear", () => {
  afterEach(async () => {
    await dom.cleanup();
  });

  test("clears every door's saved lists and modes on the login page", () => {
    // The queued check-ins stay: they carry no guest detail, and the server
    // still owes their replay.
    expect(storeAfterClear("<div data-clears-scanner-storage></div>")).toEqual({
      "scanner-queue": "[]",
    });
  });

  test("keeps the stored lists on a page that did not come from sign-out", () => {
    expect(storeAfterClear("<p>Admin page</p>")).toEqual(SEEDED);
  });

  test("clears nothing, and stops nothing, on a page whose store is blocked", () => {
    const clear = clearWhileStoreThrows(
      new DOMException("The store is blocked", "SecurityError"),
    );
    clear();
    expect(
      globalThis.localStorage.getItem("scanner-tickets-/admin/listing/9/scan"),
    ).toBe("list");
  });

  test("lets any other store fault through", () => {
    const clear = clearWhileStoreThrows(new Error("The store broke"));
    expect(clear).toThrow("The store broke");
  });
});
