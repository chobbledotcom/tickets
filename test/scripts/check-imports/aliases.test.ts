import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type Alias,
  bestSpelling,
  formatIssue,
  resolveSpecifier,
} from "#scripts/check-imports/rules.ts";
import { ALIASES } from "./fixtures.ts";

describe("resolveSpecifier", () => {
  test("reads a folder alias as the folder plus the rest", () => {
    expect(resolveSpecifier(ALIASES, "#db/client.ts")).toBe(
      "./src/shared/db/client.ts",
    );
  });

  test("reads a whole-module alias as that module", () => {
    expect(resolveSpecifier(ALIASES, "#types")).toBe("./src/shared/types.ts");
  });

  test("lets the longest matching alias win, as the runtime does", () => {
    const aliases: Alias[] = [
      { name: "#a/", target: "./one/" },
      { name: "#a/b/", target: "./two/" },
    ];
    expect(resolveSpecifier(aliases, "#a/b/c.ts")).toBe("./two/c.ts");
  });

  test("returns null for a specifier no alias covers", () => {
    expect(resolveSpecifier(ALIASES, "#nope/x.ts")).toBeNull();
  });

  test("does not read a whole-module alias as a folder", () => {
    expect(resolveSpecifier(ALIASES, "#types/extra.ts")).toBeNull();
  });
});

describe("bestSpelling", () => {
  test("prefers the shortest alias that reaches the file", () => {
    expect(bestSpelling(ALIASES, "./src/shared/db/client.ts")).toBe(
      "#db/client.ts",
    );
  });

  test("prefers a whole-module alias over spelling out the folder", () => {
    expect(bestSpelling(ALIASES, "./src/shared/types.ts")).toBe("#types");
  });

  test("never proposes an alias that omits the file extension", () => {
    expect(bestSpelling(ALIASES, "./src/shared/jsx/jsx-runtime.ts")).toBe(
      "#shared/jsx/jsx-runtime.ts",
    );
  });

  test("breaks a tie alphabetically so one file gets one answer", () => {
    const aliases: Alias[] = [
      { name: "#bb/", target: "./x/" },
      { name: "#aa/", target: "./x/" },
    ];
    expect(bestSpelling(aliases, "./x/f.ts")).toBe("#aa/f.ts");
  });

  test("keeps the shortest alias over an earlier longer one", () => {
    const aliases: Alias[] = [
      { name: "#z/", target: "./x/" },
      { name: "#aaa/", target: "./x/" },
    ];
    expect(bestSpelling(aliases, "./x/f.ts")).toBe("#z/f.ts");
  });

  test("returns null when no alias reaches the file", () => {
    expect(bestSpelling(ALIASES, "./elsewhere/f.ts")).toBeNull();
  });
});

describe("formatIssue", () => {
  test("names the file and line before the message", () => {
    expect(formatIssue("src/a.ts", { line: 7, message: "went wrong" })).toBe(
      "src/a.ts:7 went wrong",
    );
  });
});
