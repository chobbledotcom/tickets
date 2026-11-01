import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runGradeCodeCli } from "#scripts/grade-code/cli.ts";
import { gradeCode } from "#scripts/grade-code/grade.ts";
import { batchReportLines, csvLines } from "#scripts/grade-code/report.ts";
import { CLEAN_CODE, ioWith } from "./support.ts";
import {
  declaration,
  HELPER_SOURCE,
  MODEL_SOURCE,
  tlaDeps,
} from "./tla-support.ts";

const call = { ctx: { aliases: [], overLimit: {} }, jev: null };
const paid = { ...call, jev: { apiKey: "test", model: "test" } };

describe("TLA grading", () => {
  test("grades a model mechanically without TypeScript checks or execution", async () => {
    const deps = tlaDeps();
    deps.grade.fetchText = () => {
      throw new Error("No network expected");
    };
    const row = await gradeCode(deps.grade, call, "verification/Sample.tla");
    expect(row.error).toBeNull();
    expect(row.kind).toBe("tla-model");
    expect(row.checks.tla_structure?.status).toBe("PASS");
    expect(row.checks.imports_one_way).toBeUndefined();
    expect(row.checks.select_star).toBeUndefined();
    expect(row.jev).toBeNull();
  });

  test("grades a helper without invented state-machine obligations", async () => {
    const deps = tlaDeps(declaration("helper"), {
      "verification/Laws.tla": HELPER_SOURCE,
    });
    let questions: string[] = [];
    const fetch = deps.grade.fetchText;
    deps.grade.fetchText = (url, init) => {
      questions = Object.keys(JSON.parse(String(init.body)).questions);
      return fetch(url, init);
    };
    const row = await gradeCode(deps.grade, paid, "verification/Laws.tla");
    expect(row.error).toBeNull();
    expect(row.kind).toBe("tla-helper");
    expect(row.checks.tla_structure?.status).toBe("PASS");
    expect(questions).toContain("tla_shared_laws");
    expect(questions).not.toContain("tla_invariant_strength");
    expect(questions).not.toContain("tla_producer_controls");
  });

  test("reports concrete structural violations with diagnostic locations", async () => {
    const deps = tlaDeps(declaration(), {
      "verification/Sample.tla": MODEL_SOURCE.replace(
        "MODULE Sample",
        "MODULE Wrong",
      ),
    });
    const row = await gradeCode(deps.grade, call, "verification/Sample.tla");
    expect(row.error).toBeNull();
    expect(row.checks.tla_structure?.status).toBe("FAIL");
    expect(row.checks.tla_structure?.note).toMatch(/line 1:.*Sample/);
  });

  test("malformed lexical input and absent registration are ungraded", async () => {
    for (const source of [`${MODEL_SOURCE}\n"unfinished`, "not a TLA module"]) {
      const deps = tlaDeps(declaration(), {
        "verification/Sample.tla": source,
      });
      const row = await gradeCode(deps.grade, call, "verification/Sample.tla");
      expect(row.score).toBeNull();
      expect(row.error).not.toBeNull();
    }
    const deps = tlaDeps();
    deps.grade.verificationModule = () => {
      throw new Error("unregistered Sample");
    };
    const row = await gradeCode(deps.grade, call, "verification/Sample.tla");
    expect(row.error).toContain("unregistered Sample");
  });

  test("supplies only labelled source and inert declared metadata to Jev", async () => {
    const files = {
      "scripts/sample.ts": "export const observed = 1;\n",
      "src/shared/sample.ts": "export const expected = 2;\n",
      "src/shared/undeclared.ts": "do not send this",
      "verification/Laws.tla": HELPER_SOURCE,
      "verification/Sample.tla": MODEL_SOURCE,
    };
    const deps = tlaDeps(
      declaration("model", [
        "verification/Laws.tla",
        "scripts/sample.ts",
        "src/shared/sample.ts",
      ]),
      files,
    );
    let body: Record<string, unknown> = {};
    const fetch = deps.grade.fetchText;
    deps.grade.fetchText = (url, init) => {
      body = JSON.parse(String(init.body));
      return fetch(url, init);
    };
    const row = await gradeCode(deps.grade, paid, "verification/Sample.tla");
    expect(row.jevError).toBeNull();
    const state = body.state as Record<string, unknown>;
    expect(state.sql_statements).toBeUndefined();
    expect(state.as_casts).toBeUndefined();
    const sources = state.sources as {
      file: string;
      lines: { line: number; text: string }[];
    }[];
    expect(sources.map((source) => source.file)).toEqual([
      "verification/Sample.tla",
      "verification/Laws.tla",
      "scripts/sample.ts",
      "src/shared/sample.ts",
    ]);
    expect(sources[0]?.lines[0]).toEqual({
      line: 1,
      text: "---- MODULE Sample ----",
    });
    expect(JSON.stringify(state)).not.toContain("do not send this");
    expect(state.controls).toEqual([{ name: "negative", phase: "initial" }]);
    expect(Object.keys(body.questions as object)).toEqual(
      expect.arrayContaining([
        "tla_abstraction_provenance",
        "tla_invariant_strength",
        "tla_identity",
        "tla_independent_arithmetic",
        "tla_producer_controls",
        "tla_limits",
      ]),
    );
  });

  test("missing and forbidden declared context never becomes an empty review", async () => {
    for (const path of [
      "scripts/missing.ts",
      "../secret.ts",
      "src/../../secret.ts",
      ".env",
      "src/private.sqlite",
      "src/secret.json",
    ]) {
      const deps = tlaDeps(declaration("model", [path]));
      let requests = 0;
      deps.grade.fetchText = () => {
        requests++;
        throw new Error("No request expected");
      };
      const row = await gradeCode(deps.grade, paid, "verification/Sample.tla");
      expect(row.score).toBeNull();
      expect(row.error).toContain(path);
      expect(requests).toBe(0);
    }
  });

  test("unavailable or missing Jev answers preserve explicit mechanical-only results", async () => {
    for (const reply of [
      { ok: false, status: 402, text: "no credit" },
      { ok: true, status: 200, text: '{"answers":{}}' },
    ]) {
      const deps = tlaDeps();
      deps.grade.fetchText = () => Promise.resolve(reply);
      const row = await gradeCode(deps.grade, paid, "verification/Sample.tla");
      expect(row.error).toBeNull();
      expect(row.jev).toBeNull();
      expect(row.jevError).not.toBeNull();
      expect(row.checks.tla_structure?.status).toBe("PASS");
      expect(row.checks.tla_invariant_strength).toBeUndefined();
      expect(
        Object.values(row.checks).every((check) => check.engine === "code"),
      ).toBe(true);
    }
  });

  test("keeps low-confidence TLA judgments advisory", async () => {
    const deps = tlaDeps();
    deps.grade.fetchText = (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: JSON.stringify({
          answers: Object.fromEntries(
            Object.keys(JSON.parse(String(init.body)).questions).map((id) => [
              id,
              { confidence: 0.1, score: 0, type: "score" },
            ]),
          ),
        }),
      });
    const row = await gradeCode(deps.grade, paid, "verification/Sample.tla");
    expect(row.checks.tla_invariant_strength?.status).toBe("WARN");
    expect(row.checks.tla_invariant_strength?.critical).toBe(false);
  });

  test("preserves mixed JSON, CSV, batch reporting and single-file exit conventions", async () => {
    const deps = tlaDeps(declaration(), {
      "src/shared/sample.ts": CLEAN_CODE,
      "verification/Sample.tla": MODEL_SOURCE,
    });
    const { io, out } = ioWith(["src", "verification", "--no-jev", "--json"]);
    expect(await runGradeCodeCli(io, deps)).toBe(0);
    const rows = JSON.parse(out.join("\n"));
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { kind: string }) => row.kind).sort()).toEqual([
      "shared",
      "tla-model",
    ]);
    expect(csvLines(rows).join("\n")).toContain("verification/Sample.tla");
    expect(
      batchReportLines(rows, { model: "test", seconds: 0 }).join("\n"),
    ).toContain("verification/Sample.tla");
    const broken = tlaDeps(declaration(), {
      "verification/Sample.tla": MODEL_SOURCE.replace(
        "MODULE Sample",
        "MODULE Wrong",
      ),
    });
    expect(
      await runGradeCodeCli(
        ioWith(["verification/Sample.tla", "--no-jev"]).io,
        broken,
      ),
    ).toBe(1);
    expect(
      await runGradeCodeCli(
        ioWith(["verification", "--no-jev", "--json"]).io,
        broken,
      ),
    ).toBe(0);
  });
});
