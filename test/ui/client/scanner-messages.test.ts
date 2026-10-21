/**
 * The scanner wording helpers' own contract: how a message's holes render,
 * how a lookup falls back, and what a status line shows and fades. The
 * whole-page suites assert these words through built pages; this suite pins
 * the helpers directly, so the module's own mutants die here.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  formatTicketCount,
  getMessage,
  interpolate,
  showStatus,
} from "#src/ui/client/scanner-messages.js";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

const { installDom, cleanup } = createDomInstaller();
afterEach(cleanup);

describe("scanner wording helpers", () => {
  test("renders a zero count as a zero", () => {
    expect(interpolate("{count} queued check-ins", { count: 0 })).toBe(
      "0 queued check-ins",
    );
  });

  test("renders a hole with no value as nothing", () => {
    expect(interpolate("Skipped {name}", {})).toBe("Skipped ");
  });

  test("reads a stored word, and falls back when the key is absent", () => {
    const messages = { messageNotFound: "Ticket not found" };
    expect(getMessage(messages, "messageNotFound", "Missing")).toBe(
      "Ticket not found",
    );
    expect(getMessage(messages, "messageNoDoor", "No door")).toBe("No door");
  });

  test("counts one ticket and several tickets in the page's words", () => {
    const messages = {
      messageTicketCountOne: "{count} ticket",
      messageTicketCountOther: "{count} tickets",
    };
    expect(formatTicketCount(messages, 1)).toBe("1 ticket");
    expect(formatTicketCount(messages, 3)).toBe("3 tickets");
  });

  test("falls back to the module's own ticket words", () => {
    // Both fallback wordings are the same singular template; only the page's
    // rendered attributes carry the plural s.
    expect(formatTicketCount({}, 1)).toBe("1 ticket");
    expect(formatTicketCount({}, 3)).toBe("3 ticket");
  });

  test("reads an untrustworthy count as one", () => {
    expect(formatTicketCount({}, Number.NaN)).toBe("1 ticket");
  });

  describe("showStatus", () => {
    test("shows the words and the type's colour, replacing what stood before", () => {
      installDom("");
      // The fake clock keeps the fade timers the settled types schedule off
      // the real event loop.
      using _time = new FakeTime();
      const status = document.createElement("div");
      status.className = "scanner-status scanner-status-error hidden";

      showStatus(status, "Not found", "error");
      expect(status.textContent).toBe("Not found");
      expect(status.className).toBe("scanner-status scanner-status-error");

      showStatus(status, "Skipped Ada", "warning");
      expect(status.className).toBe("scanner-status scanner-status-warning");

      // The success call strips the warning the warning call left on.
      showStatus(status, "Checked in", "success");
      expect(status.className).toBe("scanner-status scanner-status-success");
    });

    test("fades a settled status out after its delay", () => {
      installDom("");
      using time = new FakeTime();
      const status = document.createElement("div");

      showStatus(status, "Checking in queued tickets...", "warning");
      time.tick(4_999);
      expect(status.className).not.toContain("scanner-status-fade-out");
      time.tick(1);
      expect(status.className).toContain("scanner-status-fade-out");

      // A success fades the same way, and strips the fade the warning
      // earned.
      showStatus(status, "Queued tickets are done.", "success");
      expect(status.className).not.toContain("scanner-status-fade-out");
      time.tick(5_000);
      expect(status.className).toContain("scanner-status-fade-out");
    });

    test("keeps a replacement solid by clearing the old fade", () => {
      installDom("");
      using time = new FakeTime();
      const status = document.createElement("div");

      showStatus(status, "Checking in queued tickets...", "warning");
      showStatus(status, "Not found", "error");
      time.tick(5_000);
      expect(status.className).toContain("scanner-status-error");
      expect(status.className).not.toContain("scanner-status-fade-out");
    });
  });
});
