import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  acceptedProblems,
  formatProblem,
  parseAccepted,
} from "#scripts/check-shapes/accepted.ts";

describe("parseAccepted", () => {
  test("reads a key and the note that says why it stands", () => {
    expect(
      parseAccepted("src/a.ts::x,src/b.ts::y  # both do one thing"),
    ).toEqual({
      entries: [{ key: "src/a.ts::x,src/b.ts::y", note: "both do one thing" }],
      malformed: [],
    });
  });

  test("skips blank lines and whole-line comments", () => {
    expect(parseAccepted("# a heading\n\n   \n").entries).toEqual([]);
  });

  test("refuses a line with no note, because a reason is the point", () => {
    expect(parseAccepted("src/a.ts::x,src/b.ts::y").malformed).toEqual([
      "src/a.ts::x,src/b.ts::y",
    ]);
  });

  test("refuses a line whose note is empty", () => {
    expect(parseAccepted("src/a.ts::x  #   ").malformed).toEqual([
      "src/a.ts::x  #",
    ]);
  });
});

describe("acceptedProblems", () => {
  const entry = { key: "k", note: "why" };

  test("finds nothing wrong with an entry that still matches", () => {
    expect(acceptedProblems([entry], [], new Set(["k"]))).toEqual([]);
  });

  test("reports an entry that matches nothing now", () => {
    expect(acceptedProblems([entry], [], new Set())).toEqual([
      { detail: "k", kind: "stale" },
    ]);
  });

  test("reports a key listed twice", () => {
    expect(acceptedProblems([entry, entry], [], new Set(["k"]))).toEqual([
      { detail: "k", kind: "duplicate" },
    ]);
  });

  test("reports a duplicate once, not once per problem", () => {
    const problems = acceptedProblems([entry, entry], [], new Set());
    expect(problems.filter((p) => p.kind === "duplicate")).toHaveLength(1);
    expect(problems.filter((p) => p.kind === "stale")).toHaveLength(1);
  });

  test("reports a line it could not read", () => {
    const problems = acceptedProblems([], ["junk"], new Set());
    expect(problems[0]?.kind).toBe("malformed");
    expect(problems[0]?.detail).toContain("junk");
  });

  test("says nothing about a match that is simply not listed", () => {
    expect(acceptedProblems([], [], new Set(["unlisted"]))).toEqual([]);
  });
});

describe("formatProblem", () => {
  test("names what is wrong before the entry it is wrong about", () => {
    expect(formatProblem({ detail: "k", kind: "stale" })).toBe(
      "matches nothing now — re-read its note, then refresh its fingerprints, or delete it: k",
    );
    expect(formatProblem({ detail: "k", kind: "duplicate" })).toBe(
      "listed twice: k",
    );
    expect(formatProblem({ detail: "k", kind: "malformed" })).toBe(
      "cannot be read: k",
    );
  });
});
