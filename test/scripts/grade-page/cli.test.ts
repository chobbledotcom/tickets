import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runGradePageCli, USAGE } from "#scripts/grade-page/cli.ts";
import { tempDir } from "#test-utils/files.ts";
import {
  BROKEN_PAGE,
  CLEAN_PAGE,
  depsOver,
  ioWith,
  jevReply,
} from "./support.ts";

describe("runGradePageCli", () => {
  test("prints usage for --help and nothing else", async () => {
    const { io, out } = ioWith(["--help"]);
    expect(await runGradePageCli(io, depsOver({ files: {} }))).toBe(0);
    expect(out[0]).toBe(USAGE);
  });

  test("prints the check schema", async () => {
    const { io, out } = ioWith(["--list-checks"]);
    expect(await runGradePageCli(io, depsOver({ files: {} }))).toBe(0);
    expect(out.join("\n")).toContain("file_length");
    expect(out.join("\n")).toContain("comments_earn_place");
  });

  test("reports a bad option", async () => {
    const { io, err } = ioWith(["--nope"]);
    expect(await runGradePageCli(io, depsOver({ files: {} }))).toBe(2);
    expect(err[0]).toContain("unknown option --nope");
  });

  test("grades one clean page mechanically and exits clean", async () => {
    const { io, out, err } = ioWith(
      ["src/features/admin/a-page.ts", "--no-jev"],
      { OPENCODE_API_KEY: "" },
    );
    const code = await runGradePageCli(
      io,
      depsOver({ files: { "src/features/admin/a-page.ts": CLEAN_PAGE } }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Score: 100/100 (A)");
    expect(err).toEqual([]);
  });

  test("exits 1 on a critical failure and names it", async () => {
    const { io, out } = ioWith(["src/features/admin/a-page.ts", "--no-jev"]);
    const code = await runGradePageCli(
      io,
      depsOver({ files: { "src/features/admin/a-page.ts": BROKEN_PAGE } }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("[CRITICAL]");
  });

  test("reports a read failure that is not an Error", async () => {
    const { io, err } = ioWith(["src/features/admin/a-page.ts", "--no-jev"]);
    const deps = depsOver({
      files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
    });
    const failing = {
      ...deps,
      grade: {
        ...deps.grade,
        readFile: () => Promise.reject("disk said no"),
      },
    };
    const code = await runGradePageCli(io, failing);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("disk said no");
  });

  test("asks Jev when a key exists and merges the answers", async () => {
    const { io, out } = ioWith(["src/features/admin/a-page.ts"], {
      OPENCODE_API_KEY: "key",
    });
    const code = await runGradePageCli(
      io,
      depsOver({ files: { "src/features/admin/a-page.ts": CLEAN_PAGE } }),
    );
    expect(code).toBe(0);
    const report = out.join("\n");
    expect(report).toContain("Comments earn their place");
    expect(report).toContain("Jev: model=jev-test");
  });

  test("falls back to mechanical-only when Jev fails", async () => {
    const { io, out, err } = ioWith(["src/features/admin/a-page.ts"], {
      OPENCODE_API_KEY: "key",
    });
    const code = await runGradePageCli(
      io,
      depsOver({
        fetchStatus: 402,
        files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
      }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Score: 100/100 (A)");
    expect(err.join("\n")).toContain("Jev unavailable (HTTP 402");
  });

  test("keeps the mechanical report when Jev replies with a page that is not JSON", async () => {
    const { io, out, err } = ioWith(["src/features/admin/a-page.ts"], {
      OPENCODE_API_KEY: "key",
    });
    const deps = depsOver({
      files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
    });
    const html = {
      ...deps,
      grade: {
        ...deps.grade,
        fetchText: () =>
          Promise.resolve({ ok: true, status: 200, text: "<html>" }),
      },
    };
    const code = await runGradePageCli(io, html);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Score: 100/100 (A)");
    expect(err.join("\n")).toContain("Jev unavailable (the answer is not JSON");
  });

  test("marks each batch page Jev failed on, apart from complete grades", async () => {
    const { io, out, err } = ioWith([], { OPENCODE_API_KEY: "key" });
    const code = await runGradePageCli(
      io,
      depsOver({
        fetchStatus: 402,
        files: {
          "src/features/admin/a-page.ts": CLEAN_PAGE,
          "src/features/admin/b-page.ts": CLEAN_PAGE,
        },
      }),
    );
    expect(code).toBe(0);
    expect(err.join("\n")).toContain(
      "(Jev failed) src/features/admin/a-page.ts",
    );
    expect(out.join("\n")).toContain("0 graded, 0 errored, 2 Jev failed");
  });

  test("grades mechanically when no key exists", async () => {
    const { io, err } = ioWith(["src/features/admin/a-page.ts"]);
    const code = await runGradePageCli(
      io,
      depsOver({
        files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
        secret: null,
      }),
    );
    expect(code).toBe(0);
    expect(err).toEqual([
      "note: no Jev API key (set OPENCODE_API_KEY); grading mechanical checks only",
    ]);
  });

  test("ranks a sweep without a key as complete mechanical grades", async () => {
    const { io, out, err } = ioWith([]);
    const code = await runGradePageCli(
      io,
      depsOver({
        files: {
          "src/features/admin/a-page.ts": CLEAN_PAGE,
          "src/features/admin/b-page.ts": CLEAN_PAGE,
        },
        secret: null,
      }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("2 graded, 0 errored, 0 Jev failed");
    expect(err.filter((line) => line.includes("no Jev API key"))).toHaveLength(
      1,
    );
  });

  test("sweeps the default pages as a batch, writing CSV beside JSON", async () => {
    using dir = tempDir();
    const csvPath = `${dir.path}/out.csv`;
    const written: Record<string, string> = {};
    const deps = {
      ...depsOver({
        files: {
          "src/features/admin/a-page.ts": CLEAN_PAGE,
          "src/features/admin/b-page.ts": BROKEN_PAGE,
        },
      }),
      writeTextFile: (path: string, text: string) => {
        written[path] = text;
        return Promise.resolve();
      },
    };
    const { io, out, err } = ioWith(["--csv", csvPath, "--json"], {});
    const code = await runGradePageCli(io, deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { file: string }[];
    expect(parsed.map((row) => row.file)).toEqual([
      "src/features/admin/b-page.ts",
      "src/features/admin/a-page.ts",
    ]);
    expect(written[csvPath]?.split("\n")[0]).toContain("failed_checks");
    expect(err.join("\n")).toContain("CSV written to");
  });

  test("prints a skip line for a page that cannot be graded", async () => {
    const { io, out, err } = ioWith([]);
    const code = await runGradePageCli(
      io,
      depsOver({
        files: {
          "src/features/admin/a-page.ts": CLEAN_PAGE,
          "src/features/admin/b-page.ts": "const (",
        },
      }),
    );
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("SKIP src/features/admin/b-page.ts");
    expect(out.join("\n")).toContain("1 graded, 1 errored");
  });

  test("exits 2 when the alias table or the over-limit list cannot be read", async () => {
    const noAliases = {
      ...depsOver({ files: { "src/features/admin/a-page.ts": CLEAN_PAGE } }),
      aliases: () => Promise.resolve(null),
    };
    const { io, err } = ioWith(["src/features/admin/a-page.ts", "--no-jev"]);
    expect(await runGradePageCli(io, noAliases)).toBe(2);
    expect(err.join("\n")).toContain("cannot read deno.json");

    const noList = {
      ...depsOver({ files: { "src/features/admin/a-page.ts": CLEAN_PAGE } }),
      overLimit: () => Promise.resolve(null),
    };
    const again = ioWith(["src/features/admin/a-page.ts", "--no-jev"]);
    expect(await runGradePageCli(again.io, noList)).toBe(2);
    expect(again.err.join("\n")).toContain("cannot read");
  });

  test("exits 2 on a target that does not read", async () => {
    const { io, err } = ioWith(["src/features/admin/nope-page.ts"]);
    expect(await runGradePageCli(io, depsOver({ files: {} }))).toBe(2);
    expect(err.join("\n")).toContain("cannot read");
  });

  test("prints the call without token counts when the reply carries none", async () => {
    const { io, out } = ioWith(["src/features/admin/a-page.ts"], {
      OPENCODE_API_KEY: "key",
    });
    const deps = depsOver({
      files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
    });
    const bare = {
      ...deps,
      grade: {
        ...deps.grade,
        fetchText: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: jevReply({}),
          }),
      },
    };
    const code = await runGradePageCli(io, bare);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Jev: model=jev-1.13, 0.00s");
  });

  test("prints input tokens alone when the reply carries no output count", async () => {
    const { io, out } = ioWith(["src/features/admin/a-page.ts"], {
      OPENCODE_API_KEY: "key",
    });
    const deps = depsOver({
      files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
    });
    const half = {
      ...deps,
      grade: {
        ...deps.grade,
        fetchText: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            text: jevReply({ model: "jev-test", usage: { input_tokens: 7 } }),
          }),
      },
    };
    const code = await runGradePageCli(io, half);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain(
      "Jev: model=jev-test, 7 in / ? out tokens",
    );
  });

  test("prints the batch table without json, honouring --limit", async () => {
    const { io, out, err } = ioWith(["--limit", "2"]);
    const code = await runGradePageCli(
      io,
      depsOver({
        files: {
          "src/features/admin/a-page.ts": CLEAN_PAGE,
          "src/features/admin/b-page.ts": CLEAN_PAGE,
          "src/features/admin/c-page.ts": CLEAN_PAGE,
        },
      }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("batch of 2");
    expect(out.join("\n")).toContain("2 graded, 0 errored");
    expect(err.join("\n")).toContain("[2/2]");
  });
});

describe("the fake repository the CLI tests run on", () => {
  test("reads a missing fixture page as empty and resolves the wait", async () => {
    const deps = depsOver({ files: {} });
    expect(await deps.grade.readFile("src/nowhere.ts")).toBe("");
    expect(await deps.grade.sleep(0)).toBeUndefined();
  });

  test("hands the secret file's key to the loader", async () => {
    const { io, out } = ioWith(["src/features/admin/a-page.ts"]);
    const code = await runGradePageCli(
      io,
      depsOver({
        files: { "src/features/admin/a-page.ts": CLEAN_PAGE },
        secret: "file-key",
      }),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Jev: model=jev-test");
  });

  test("writes the CSV path through the fake's write hook", async () => {
    const { io, err } = ioWith(["--csv", "out.csv", "--no-jev"]);
    const code = await runGradePageCli(
      io,
      depsOver({
        files: {
          "src/features/admin/a-page.ts": CLEAN_PAGE,
          "src/features/admin/b-page.ts": CLEAN_PAGE,
        },
      }),
    );
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("CSV written to out.csv");
  });
});
