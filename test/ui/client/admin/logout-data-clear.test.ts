import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initLogoutDataClear } from "#src/ui/client/admin/logout-data-clear.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const dom = createDomInstaller(["localStorage"]);

describe("logout data clear", () => {
  afterEach(async () => {
    await dom.cleanup();
  });

  /** Seed the scanner storage of two doors, and a queue. */
  const seedStore = (): void => {
    localStorage.setItem("scanner-tickets-/admin/listing/9/scan", "list-9");
    localStorage.setItem("scanner-tickets-/admin/groups/5/scan", "list-5");
    localStorage.setItem("scanner-offline-mode-/admin/listing/9/scan", "1");
    localStorage.setItem("scanner-queue", "[]");
  };

  test("clears every door's saved lists and modes on the login page", () => {
    const window = dom.installDom("<div data-clears-scanner-storage></div>");
    seedStore();

    initLogoutDataClear();

    expect(
      window.localStorage.getItem("scanner-tickets-/admin/listing/9/scan"),
    ).toBe(null);
    expect(
      window.localStorage.getItem("scanner-tickets-/admin/groups/5/scan"),
    ).toBe(null);
    expect(
      window.localStorage.getItem("scanner-offline-mode-/admin/listing/9/scan"),
    ).toBe(null);
    // The queued check-ins stay: they carry no guest detail, and the server
    // still owes their replay.
    expect(window.localStorage.getItem("scanner-queue")).toBe("[]");
  });

  test("keeps the stored lists on a page that did not come from sign-out", () => {
    const window = dom.installDom("<p>Admin page</p>");
    seedStore();

    initLogoutDataClear();

    expect(
      window.localStorage.getItem("scanner-tickets-/admin/listing/9/scan"),
    ).toBe("list-9");
    expect(
      window.localStorage.getItem("scanner-offline-mode-/admin/listing/9/scan"),
    ).toBe("1");
  });

  test("clears nothing on a page whose store is blocked", () => {
    dom.installDom("<div data-clears-scanner-storage></div>");
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    if (descriptor === undefined) throw new Error("No localStorage to block");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The store is blocked", "SecurityError");
      },
    });
    try {
      expect(() => initLogoutDataClear()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, "localStorage", descriptor);
    }
  });
});
