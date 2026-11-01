import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runGradeCodeCli } from "#scripts/grade-code/cli.ts";
import { gradeCode } from "#scripts/grade-code/grade.ts";
import {
  BROKEN_CODE,
  CLEAN_CODE,
  depsOver,
  ioWith,
  jevReply,
} from "./support.ts";
import {
  declaration,
  HELPER_SOURCE,
  MODEL_SOURCE,
  tlaDeps,
} from "./tla-support.ts";

const call = { ctx: { aliases: [], overLimit: {} }, jev: null };

describe("language-specific grading profiles", () => {
  test("keeps TypeScript evidence, questions and one-call Jev cost without registry/context reads", async () => {
    const deps = depsOver({ files: { "src/features/sample.ts": CLEAN_CODE } });
    deps.grade.verificationModule = () => {
      throw new Error("TS read metadata");
    };
    deps.grade.readContext = () => {
      throw new Error("TS read TLA context");
    };
    let requests = 0;
    deps.grade.fetchText = (_url, init) => {
      requests++;
      const body = JSON.parse(String(init.body));
      expect(body.state.file).toBe("src/features/sample.ts");
      expect(body.state.imports).toEqual(["#i18n"]);
      expect(body.state.as_casts).toEqual([]);
      expect(body.state.sources).toBeUndefined();
      expect(Object.keys(body.questions)).toContain("comments_earn_place");
      expect(
        Object.keys(body.questions).some((id) => id.startsWith("tla_")),
      ).toBe(false);
      return Promise.resolve({ ok: true, status: 200, text: jevReply() });
    };
    const row = await gradeCode(
      deps.grade,
      {
        ...call,
        jev: { apiKey: "test", model: "test" },
      },
      "src/features/sample.ts",
    );
    expect(row.error).toBeNull();
    expect(row.jevError).toBeNull();
    expect(row.kind).toBe("feature");
    expect(requests).toBe(1);
    expect(row.checks.empty_catch?.status).toBe("PASS");
    expect(row.checks.tla_structure).toBeUndefined();
  });

  test("retains concrete TypeScript mechanical failures", async () => {
    const deps = depsOver({ files: { "src/features/sample.ts": BROKEN_CODE } });
    const row = await gradeCode(deps.grade, call, "src/features/sample.ts");
    expect(row.error).toBeNull();
    expect(row.checks.empty_catch?.status).toBe("FAIL");
    expect(row.checks.empty_catch?.critical).toBe(true);
  });

  test("grades a TLA helper without a key and never requests paid review", async () => {
    const deps = tlaDeps(declaration("helper"), {
      "verification/Laws.tla": HELPER_SOURCE,
    });
    deps.grade.fetchText = () => {
      throw new Error("No paid request without a key");
    };
    const { io, out, err } = ioWith(["verification/Laws.tla", "--json"]);
    expect(await runGradeCodeCli(io, deps)).toBe(0);
    const [row] = JSON.parse(out.join("\n"));
    expect(row.kind).toBe("tla-helper");
    expect(row.error).toBeNull();
    expect(row.jev).toBeNull();
    expect(row.checks.tla_structure.status).toBe("PASS");
    expect(err.some((line) => line.includes("no Jev API key"))).toBe(true);
  });

  test("does not silently accept missing declared context with Jev disabled", async () => {
    const deps = tlaDeps(declaration("model", ["scripts/missing.ts"]));
    const row = await gradeCode(deps.grade, call, "verification/Sample.tla");
    expect(row.score).toBeNull();
    expect(row.error).toContain("scripts/missing.ts");
  });

  test("classifying stateful source as a helper produces a located mechanical failure", async () => {
    const deps = tlaDeps(declaration("helper"), {
      "verification/Laws.tla": HELPER_SOURCE.replace(
        "Nonnegative(value)",
        "VARIABLE value\nNonnegative(value)",
      ),
    });
    const row = await gradeCode(deps.grade, call, "verification/Laws.tla");
    expect(row.error).toBeNull();
    expect(row.checks.tla_structure?.status).toBe("FAIL");
    expect(row.checks.tla_structure?.note).toMatch(/line 2:.*variables/i);
  });

  test("TLA strings resembling TS constructs never become TS findings", async () => {
    const deps = tlaDeps(declaration(), {
      "verification/Sample.tla": MODEL_SOURCE.replace(
        "====",
        'Copy == "SELECT * FROM source; catch {} rows.forEach(x => x!)"\n====',
      ),
    });
    const row = await gradeCode(deps.grade, call, "verification/Sample.tla");
    expect(row.error).toBeNull();
    expect(Object.keys(row.checks)).toEqual(["tla_structure"]);
    expect(row.checks.tla_structure?.status).toBe("PASS");
  });
});
