import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  approvedContextPath,
  readContextSource,
} from "#scripts/grade-code/tla-context.ts";

describe("declared TLA source context", () => {
  test("accepts declared TS, JS and TLA paths from the approved roots", () => {
    for (const path of [
      "src/shared/sample.ts",
      "scripts/sample.js",
      "verification/Sample.tla",
    ]) {
      expect(approvedContextPath(path)).toBe(path);
    }
  });

  test("rejects escapes, hidden paths, data files, unsupported roots and noncanonical spellings", () => {
    for (const path of [
      "../src/file.ts",
      "src/../scripts/file.ts",
      "./src/file.ts",
      "src//file.ts",
      "src/.env.ts",
      "src/.private/file.ts",
      "src/file.sqlite",
      "src/file.json",
      "test/file.ts",
      "verification\\file.tla",
    ]) {
      expect(() => approvedContextPath(path)).toThrow(path);
    }
  });

  test("refuses forbidden context before attempting filesystem access", async () => {
    for (const path of [
      "/unavailable/private-source.ts",
      "../private-source.ts",
      ".env",
      "src/.credentials.ts",
      "src/private.sqlite",
      "test/private-source.ts",
    ]) {
      await expect(readContextSource(path)).rejects.toThrow(
        `Forbidden TLA review context: ${path}`,
      );
    }
  });
});
