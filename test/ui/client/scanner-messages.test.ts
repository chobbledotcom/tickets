/**
 * The camera status's own contract: what a status line shows and when it
 * fades. The whole-page suites assert statuses through built pages. This
 * suite pins the module directly, so its own mutants die here.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { showStatus } from "#src/ui/client/scanner-messages.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();
afterEach(cleanup);

describe("scanner status", () => {
  describe("showStatus", () => {
    test("shows the words and the type's colour, replacing what stood before", () => {
      installDom("");
      // The fake clock keeps the fade timers the settled types schedule off
      // the real event loop.
      using time = new FakeTime();
      const status = document.createElement("div");
      status.className = "scanner-status scanner-status-error hidden";

      // The first status clears a handle the module has never set, so a
      // timer armed before it must survive.
      let earlierTimerRan = false;
      setTimeout(() => {
        earlierTimerRan = true;
      }, 100);

      showStatus(status, "Not found", "error");
      expect(status.textContent).toBe("Not found");
      expect(status.className).toBe("scanner-status scanner-status-error");

      showStatus(status, "Skipped Ada", "warning");
      expect(status.textContent).toBe("Skipped Ada");
      expect(status.className).toBe("scanner-status scanner-status-warning");

      // Each later status strips the colour the last one left on.
      showStatus(status, "Checked in", "success");
      expect(status.textContent).toBe("Checked in");
      expect(status.className).toBe("scanner-status scanner-status-success");

      showStatus(status, "Ticket not found", "error");
      expect(status.className).toBe("scanner-status scanner-status-error");

      time.tick(5_100);
      expect(earlierTimerRan).toBe(true);
    });

    test("fades a settled status out after its delay", () => {
      installDom("");
      using time = new FakeTime();
      const status = document.createElement("div");

      showStatus(status, "Checking in queued tickets...", "warning");
      time.tick(4_999);
      assert(!status.className.includes("scanner-status-fade-out"));
      time.tick(1);
      assertStringIncludes(status.className, "scanner-status-fade-out");

      // A success fades the same way, and strips the fade the warning
      // earned.
      showStatus(status, "Queued tickets are done.", "success");
      assert(!status.className.includes("scanner-status-fade-out"));
      time.tick(5_000);
      assertStringIncludes(status.className, "scanner-status-fade-out");
    });

    test("keeps a replacement solid by clearing the old fade", () => {
      installDom("");
      using time = new FakeTime();
      const status = document.createElement("div");

      showStatus(status, "Checking in queued tickets...", "warning");
      showStatus(status, "Not found", "error");
      time.tick(5_000);
      assertStringIncludes(status.className, "scanner-status-error");
      assert(!status.className.includes("scanner-status-fade-out"));
    });
  });
});
