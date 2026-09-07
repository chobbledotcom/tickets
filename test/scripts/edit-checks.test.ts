import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  biomeApplies,
  createPipeline,
  formatBiome,
  formatScans,
  scansFor,
  type ToolRun,
} from "#scripts/edit-checks/pipeline.ts";
import { createRunner, runnerPrefix } from "#scripts/edit-checks/runner.ts";

type PendingCall = {
  args: string[];
  resolved: boolean;
  resolve: (run: ToolRun) => void;
};

// Lets the queued pipeline start its next tool call before the test looks
// at what is in flight.
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const recordingPipeline = () => {
  const calls: PendingCall[] = [];
  const pipeline = createPipeline({
    runTool: (args) =>
      new Promise((resolve) => calls.push({ args, resolve, resolved: false })),
  });
  const drain = async (): Promise<void> => {
    while (true) {
      await flush();
      const pending = calls.filter((call) => !call.resolved);
      if (pending.length === 0) return;
      for (const call of pending) {
        call.resolved = true;
        call.resolve({ ok: true, text: `ran ${call.args.join(" ")}` });
      }
    }
  };
  return { calls, drain, pipeline };
};

const call = (calls: PendingCall[], index: number): PendingCall => {
  const pending = calls[index];
  if (pending === undefined) throw new Error(`no recorded call ${index}`);
  return pending;
};

describe("edit-checks pipeline", () => {
  test("runs Biome on the edited file before the jscpd scans", async () => {
    const { calls, pipeline, drain } = recordingPipeline();

    const run = pipeline("src/shared/dates.ts");
    await drain();
    await run;

    expect(calls.length).toBe(4);
    expect(call(calls, 0).args).toEqual([
      "scripts/biome.ts",
      "check",
      "--write",
      "--error-on-warnings",
      "src/shared/dates.ts",
    ]);
    expect(calls.slice(1).map((pending) => pending.args[0])).toEqual([
      "scripts/cpd.ts",
      "scripts/cpd.ts",
      "scripts/cpd.ts",
    ]);
    expect(calls.slice(1).map((pending) => pending.args[2])).toEqual([
      ".jscpd.json",
      ".jscpd.specs.json",
      ".jscpd.helpers.json",
    ]);
  });

  test("keeps a second edit's Biome write behind the first edit's scans", async () => {
    const { calls, pipeline, drain } = recordingPipeline();

    const first = pipeline("src/a.ts");
    const second = pipeline("src/b.ts");
    await flush();

    expect(calls.length).toBe(1);
    expect(call(calls, 0).args[0]).toContain("biome.ts");

    await drain();
    const firstText = await first;
    const secondText = await second;

    expect(calls.map((pending) => pending.args[0])).toEqual([
      "scripts/biome.ts",
      "scripts/cpd.ts",
      "scripts/cpd.ts",
      "scripts/cpd.ts",
      "scripts/biome.ts",
      "scripts/cpd.ts",
      "scripts/cpd.ts",
      "scripts/cpd.ts",
    ]);
    expect(firstText).toContain("src/a.ts");
    expect(firstText).not.toContain("src/b.ts");
    expect(secondText).toContain("src/b.ts");
    expect(secondText).not.toContain("src/a.ts");
  });

  test("keeps checking later edits after a failed run", async () => {
    let fail = true;
    const pipeline = createPipeline({
      runTool: async () => {
        if (fail) throw new Error("tool exploded");
        return { ok: true, text: "ran" };
      },
    });

    await expect(pipeline("src/broken.ts")).rejects.toThrow("tool exploded");
    fail = false;
    expect(await pipeline("src/next.ts")).toContain("biome: ran");
  });

  test("runs no checks for a file outside the scanned trees", async () => {
    const { calls, pipeline } = recordingPipeline();

    expect(await pipeline("README.md")).toBe("");
    expect(calls.length).toBe(0);
  });

  test("reports a failed scan to its own edit only", async () => {
    const { calls, pipeline, drain } = recordingPipeline();

    const failed = pipeline("src/dup.ts");
    await flush();
    expect(calls.length).toBe(1);
    call(calls, 0).resolve({ ok: true, text: "fixed" });
    await flush();

    expect(calls.length).toBe(4);
    for (const index of [1, 2, 3]) {
      call(calls, index).resolve({ ok: false, text: "clone pair" });
    }
    await drain();

    const text = await failed;
    expect(text).toContain("jscpd: duplicated code found");
    expect(text).toContain("clone pair");
  });
});

describe("edit-checks file classification", () => {
  test("runs Biome on linted trees and skips generated and vendored files", () => {
    expect(biomeApplies("src/shared/dates.ts")).toBe(true);
    expect(biomeApplies("test/shared/dates.test.ts")).toBe(true);
    expect(biomeApplies("src/ui/static/bundle.js")).toBe(false);
    expect(biomeApplies("src/ui/client/scanner.js")).toBe(false);
    expect(biomeApplies("README.md")).toBe(false);
  });

  test("maps each tree to its jscpd configs", () => {
    const configsFor = (relPath: string): string[] =>
      scansFor(relPath).map((run) => run.config);
    expect(configsFor("src/shared/dates.ts")).toEqual([
      ".jscpd.json",
      ".jscpd.specs.json",
      ".jscpd.helpers.json",
    ]);
    expect(configsFor("scripts/cpd.ts")).toEqual([".jscpd.json"]);
    expect(configsFor("e2e-payments/src/main.ts")).toEqual([".jscpd.json"]);
    expect(configsFor("test/specs/support/browser.ts")).toEqual([
      ".jscpd.specs.json",
      ".jscpd.support.json",
    ]);
    expect(configsFor("test/test-utils/db.ts")).toEqual([
      ".jscpd.helpers.json",
      ".jscpd.test.json",
    ]);
    expect(configsFor("test/shared/dates.test.ts")).toEqual([
      ".jscpd.test.json",
    ]);
    expect(configsFor("README.md")).toEqual([]);
  });

  test("scans the stylesheet with the css config and its file path", () => {
    expect(scansFor("src/ui/static/style.scss")).toEqual([
      { config: ".jscpd.css.json", paths: ["src/ui/static/style.scss"] },
    ]);
  });
});

describe("edit-checks formatting", () => {
  test("shows the last Biome line when it is clean", () => {
    expect(
      formatBiome({ label: "biome", ok: true, text: "Checked 3 files" }),
    ).toBe("biome: Checked 3 files");
  });

  test("falls back to clean when Biome printed nothing", () => {
    expect(formatBiome({ label: "biome", ok: true, text: "" })).toBe(
      "biome: clean",
    );
  });

  test("strips ANSI escapes from the tool output", () => {
    expect(
      formatBiome({
        label: "biome",
        ok: true,
        text: "\u001b[32mChecked 3 files\u001b[0m",
      }),
    ).toBe("biome: Checked 3 files");
  });

  test("drops config chatter and the cpd policy banner", () => {
    const text = formatBiome({
      label: "biome",
      ok: false,
      text: [
        "config file .jscpd.json",
        "Using config from .jscpd.json",
        "clone pair in src/a.ts",
        "━━━ the policy banner",
        "more policy text",
      ].join("\n"),
    });
    expect(text).toContain("biome: found lint issues");
    expect(text).toContain("clone pair in src/a.ts");
    expect(text).not.toContain("config");
    expect(text).not.toContain("policy");
  });

  test("caps long Biome failure output", () => {
    const text = formatBiome({
      label: "biome",
      ok: false,
      text: Array.from({ length: 150 }, (_, index) => `line ${index}`).join(
        "\n",
      ),
    });
    expect(text).toContain("biome: found lint issues");
    expect(text).toContain("line 119");
    expect(text).not.toContain("line 120");
    expect(text).toContain("… truncated");
  });

  test("lists the labels when every scan is clean", () => {
    expect(
      formatScans([
        { label: ".jscpd.json", ok: true, text: "" },
        { label: ".jscpd.test.json", ok: true, text: "" },
      ]),
    ).toBe("jscpd: clean (.jscpd.json, .jscpd.test.json)");
  });

  test("joins the failed scans with their output", () => {
    const text = formatScans([
      { label: ".jscpd.json", ok: true, text: "" },
      { label: ".jscpd.test.json", ok: false, text: "clone pair" },
    ]);
    expect(text).toBe(
      "jscpd: duplicated code found (.jscpd.test.json)\nclone pair",
    );
  });
});

describe("edit-checks runner", () => {
  test("uses the pinned deno inside the nix devshell", () => {
    expect(runnerPrefix({ IN_NIX_SHELL: "1" })).toEqual(["deno"]);
  });

  test("wraps deno in nix develop outside the devshell", () => {
    expect(runnerPrefix({})).toEqual(["nix", "develop", "-c", "deno"]);
  });

  const withFixture = async (
    body: string,
    run: (path: string) => Promise<void>,
  ): Promise<void> => {
    const dir = await Deno.makeTempDir();
    const path = `${dir}/fixture.ts`;
    await Deno.writeTextFile(path, body);
    try {
      await run(path);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  };

  test("captures the output of a clean check", async () => {
    await withFixture('console.log("from-check");', async (path) => {
      const runTool = createRunner({ worktree: Deno.cwd() });
      const result = await runTool([path]);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("from-check");
    });
  });

  test("fails with the tool output when the check exits non-zero", async () => {
    await withFixture(
      'console.error("bad-thing"); Deno.exit(3);',
      async (path) => {
        const runTool = createRunner({ worktree: Deno.cwd() });
        const result = await runTool([path]);
        expect(result.ok).toBe(false);
        expect(result.text).toContain("bad-thing");
      },
    );
  });

  test("terminates a stalled checker and reports the timeout", async () => {
    await withFixture(
      "await new Promise((resolve) => setTimeout(resolve, 60000));",
      async (path) => {
        const runTool = createRunner({
          timeoutMs: 200,
          worktree: Deno.cwd(),
        });
        const startedAt = Date.now();
        const result = await runTool([path]);
        const elapsed = Date.now() - startedAt;
        expect(result.ok).toBe(false);
        expect(result.text).toContain("timed out");
        expect(elapsed).toBeLessThan(30_000);
      },
    );
  });
});
