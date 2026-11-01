import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { describe, it as test } from "@std/testing/bdd";
import { assertSpyCalls, spy, stub } from "@std/testing/mock";
import { denoCliDeps } from "#scripts/grade-code/cli.ts";
import { gradeCode } from "#scripts/grade-code/grade.ts";
import { extractTla } from "#scripts/grade-code/tla.ts";
import {
  approvedContextPath,
  readContextSource,
} from "#scripts/grade-code/tla-context.ts";
import { tempDir } from "#test-utils/files.ts";
import { declaration, tlaDeps } from "./tla-support.ts";

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

  test("preserves maintained model, helper and production context as complete one-based source evidence", async () => {
    const file = "verification/VatLedger.tla";
    const deps = denoCliDeps().grade;
    const content = await deps.readFile(file);
    const facts = await extractTla(deps, file, content);
    expect(facts.sources.map((source) => source.file)).toEqual([
      file,
      ...facts.declaration.context,
    ]);
    expect(facts.sources.map((source) => source.file)).toContain(
      "verification/ModelRules.tla",
    );
    for (const source of facts.sources) {
      const original = await Deno.readTextFile(source.file);
      expect(source.lines.map((line) => line.line)).toEqual(
        original.split("\n").map((_text, index) => index + 1),
      );
      expect(source.lines.map((line) => line.text).join("\n")).toBe(original);
    }
    expect(facts.source.moduleName).toBe("VatLedger");
    expect(facts.kind).toBe("tla-model");
  });

  test("reports a missing real context source without making a paid request", async () => {
    const path = "scripts/missing-grader-context.ts";
    const deps = tlaDeps(declaration("model", [path]));
    deps.grade.readContext = readContextSource;
    const requests = spy(deps.grade.fetchText);
    deps.grade.fetchText = requests;
    const row = await gradeCode(
      deps.grade,
      {
        ctx: { aliases: [], overLimit: {} },
        jev: { apiKey: "test", model: "test" },
      },
      "verification/Sample.tla",
    );
    expect(row.score).toBeNull();
    expect(row.error).toContain(
      `verification/Sample.tla: cannot read declared context ${path}:`,
    );
    expect(row.checks).toEqual({});
    expect(row.jev).toBeNull();
    assertSpyCalls(requests, 0);
  });

  test("refuses context that has become a directory before reading or paying for it", async () => {
    using dir = tempDir();
    const path = "scripts/verify-models/vat.ts";
    const lstat = Deno.lstat;
    // Redirect only this source's metadata to an isolated real directory.
    using _lstat = stub(Deno, "lstat", (candidate) =>
      lstat(
        [path, resolve(path)].includes(String(candidate))
          ? dir.path
          : candidate,
      ),
    );
    using reads = spy(Deno, "readTextFile");
    const deps = tlaDeps(declaration("model", [path]));
    deps.grade.readContext = readContextSource;
    const requests = spy(deps.grade.fetchText);
    deps.grade.fetchText = requests;
    const row = await gradeCode(
      deps.grade,
      {
        ctx: { aliases: [], overLimit: {} },
        jev: { apiKey: "test", model: "test" },
      },
      "verification/Sample.tla",
    );
    expect(row.score).toBeNull();
    expect(row.error).toContain(path);
    expect(row.checks).toEqual({});
    expect(row.jev).toBeNull();
    assertSpyCalls(reads, 0);
    assertSpyCalls(requests, 0);
  });
});
