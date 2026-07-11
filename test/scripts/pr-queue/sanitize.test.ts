import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  sanitizeSummary,
  stripControlChars,
} from "../../../scripts/pr-queue/sanitize.ts";
import type { PrSummary } from "../../../scripts/pr-queue/types.ts";

describe("stripControlChars", () => {
  test("removes C0 control bytes (ESC, bell) but keeps the visible text", () => {
    // ESC-[2J (a screen clear) plus a bell must be removed, the text kept.
    expect(stripControlChars("clear\u001b[2J\u0007screen")).toBe(
      "clear[2Jscreen",
    );
  });

  test("removes C1 control bytes but keeps printable non-ASCII characters", () => {
    // "caf\u00e9" + NEL (U+0085, a C1 control) + "menu": the accent survives.
    expect(stripControlChars("caf\u00e9\u0085menu")).toBe("caf\u00e9menu");
  });

  test("leaves plain text untouched", () => {
    expect(stripControlChars("owner/name")).toBe("owner/name");
  });
});

describe("sanitizeSummary", () => {
  const dirty: PrSummary = {
    author: "alice",
    branch: "ev\u0007il",
    bucket: "ATTENTION",
    facts: ["did \u001b[31mx", "and y"],
    number: 7,
    title: "clear\u001b[2Jscreen",
    updatedAt: "2026-07-10T12:00:00Z",
  };

  test("strips control bytes from every GitHub-sourced string", () => {
    expect(sanitizeSummary(dirty)).toEqual({
      author: "alice",
      branch: "evil",
      bucket: "ATTENTION",
      facts: ["did [31mx", "and y"],
      number: 7,
      title: "clear[2Jscreen",
      updatedAt: "2026-07-10T12:00:00Z",
    });
  });

  test("returns a new object, leaving the input summary unmutated", () => {
    const input: PrSummary = { ...dirty };
    sanitizeSummary(input);
    expect(input.title).toBe("clear\u001b[2Jscreen");
  });
});
