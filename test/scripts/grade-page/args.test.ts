import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseGradeArgs, resolveTargets } from "#scripts/grade-page/cli.ts";
import { CLEAN_PAGE, depsOver } from "./support.ts";

describe("parseGradeArgs", () => {
  test("fills the defaults", () => {
    const args = parseGradeArgs(["a.ts"]);
    expect(args.workers).toBe(4);
    expect(args.limit).toBe(0);
    expect(args.csv).toBeNull();
    expect(args.model).toBe("jev-1.13");
    expect(args.noJev).toBe(false);
    expect(args.targets).toEqual(["a.ts"]);
  });

  test("reads the flags", () => {
    const args = parseGradeArgs([
      "--no-jev",
      "--json",
      "--list-checks",
      "--workers",
      "7",
      "--limit",
      "3",
      "--csv",
      "out.csv",
      "--model",
      "jev-1.13-free",
    ]);
    expect(args.noJev).toBe(true);
    expect(args.json).toBe(true);
    expect(args.listChecks).toBe(true);
    expect(args.workers).toBe(7);
    expect(args.limit).toBe(3);
    expect(args.csv).toBe("out.csv");
    expect(args.model).toBe("jev-1.13-free");
  });

  test("refuses unknown options and bad numbers", () => {
    expect(() => parseGradeArgs(["--nope"])).toThrow("unknown option --nope");
    expect(() => parseGradeArgs(["--workers", "0"])).toThrow("--workers");
    expect(() => parseGradeArgs(["--limit", "x"])).toThrow("--limit");
  });
});

describe("resolveTargets", () => {
  const deps = depsOver({
    files: {
      "src/features/admin/a-page.ts": CLEAN_PAGE,
      "src/features/admin/b-page.ts": CLEAN_PAGE,
      "src/shared/dates.ts": CLEAN_PAGE,
    },
  });

  test("grades every page module when no target is named", async () => {
    const resolved = await resolveTargets([], deps);
    expect(resolved.error).toBeNull();
    expect(resolved.targets).toEqual([
      "src/features/admin/a-page.ts",
      "src/features/admin/b-page.ts",
    ]);
  });

  test("takes one file or a whole directory", async () => {
    const one = await resolveTargets(["src/shared/dates.ts"], deps);
    expect(one.targets).toEqual(["src/shared/dates.ts"]);
    const dir = await resolveTargets(["src/features"], deps);
    expect(dir.targets).toHaveLength(2);
  });

  test("refuses paths outside src and paths that do not read", async () => {
    expect((await resolveTargets(["scripts/x.ts"], deps)).error).toContain(
      "not under src/",
    );
    expect((await resolveTargets(["src/nope.ts"], deps)).error).toContain(
      "cannot read",
    );
    const empty = await resolveTargets(
      ["src/features"],
      depsOver({ dirs: ["src/features"], files: {} }),
    );
    expect(empty.error).toBe("no source files under src/features");
    const none = await resolveTargets([], depsOver({ files: {} }));
    expect(none.error).toBe("no page modules under src/");
  });
});
