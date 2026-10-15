import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runCompactDenoTest } from "#scripts/compact-test-reporter.ts";
import { capturingConsole } from "#test-utils/captured-console.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import { has, says } from "#test-utils/says.ts";

describe("running deno test with the compact reporter", () => {
  /** Run the compact reporter over a child with a report at the run path. */
  const runWithJUnitReport = async (
    dir: TempPath,
    args: string[],
  ): Promise<{ errors: string[]; value: number }> =>
    capturingConsole(() =>
      runCompactDenoTest(args, {
        cwd: dir.path,
        env: { CI: "1" },
        junitPath: "junit.xml",
      }),
    );

  /** Write a one-test file and run the compact reporter over it. A filter
   * travels to the child as deno's own `--filter` — the fixture is a plain
   * test, where deno's and the repo's filter agree — and to the parent's
   * zero-match check as the same value. */
  const runOver = async (
    body: string,
    options: { nameFilter?: string } = {},
  ): Promise<{ code: number; logs: string[] }> => {
    const dir: TempPath = tempDir();
    try {
      Deno.writeTextFileSync(`${dir.path}/sample.test.ts`, body);
      const { errors, logs, value } = await capturingConsole(() =>
        runCompactDenoTest(
          [
            "test",
            "--no-check",
            "-A",
            "--reporter=tap",
            ...(options.nameFilter === undefined
              ? []
              : ["--filter", options.nameFilter]),
            "sample.test.ts",
          ],
          {
            cwd: dir.path,
            env: { CI: "1" },
            ...(options.nameFilter === undefined
              ? {}
              : { nameFilter: options.nameFilter }),
          },
        ),
      );
      return { code: value, logs: [...logs, ...errors] };
    } finally {
      dir.dispose();
    }
  };

  test("reports a passing file and exits with its code", async () => {
    const { code, logs } = await runOver('Deno.test("works", () => {});');

    expect(code).toBe(0);
    has(logs, "Running tests...");
    has(logs, "\nPASS 1 passed");
    // CI in the environment hides the progress bar.
    has(logs, "ok   works");
  });

  test("reports a failing file and exits with its code", async () => {
    const { code, logs } = await runOver(
      'Deno.test("breaks", () => { throw new Error("nope"); });',
    );

    expect(code).not.toBe(0);
    has(logs, "\nFAILED 0 passed, 1 failed");
    says(logs.join("\n"), "nope");
  });

  test("shows an error line a dying child printed on stdout", async () => {
    const dir: TempPath = tempDir();
    try {
      const { errors, value } = await capturingConsole(() =>
        runCompactDenoTest(
          [
            "eval",
            'console.log("error: Uncaught boom from the dying child"); Deno.exit(1);',
          ],
          { cwd: dir.path, env: { CI: "1" } },
        ),
      );

      expect(value).toBe(1);
      says(errors.join("\n"), "error: Uncaught boom from the dying child");
      says(errors.join("\n"), "deno exited with code 1");
    } finally {
      dir.dispose();
    }
  });

  test("lets a report path failure other than a missing file surface", async () => {
    const dir: TempPath = tempDir();
    try {
      // A filled directory cannot be removed, so the run must surface the
      // failure instead of treating the path as absent.
      Deno.writeTextFileSync(`${dir.path}/blocked.xml`, "not a report\n");
      await expect(
        runCompactDenoTest(["eval", "Deno.exit(0);"], {
          cwd: dir.path,
          env: { CI: "1" },
          junitPath: dir.path,
        }),
      ).rejects.toThrow();
    } finally {
      dir.dispose();
    }
  });

  test("names the uncaught-error file a failing run's JUnit report holds", async () => {
    const dir: TempPath = tempDir();
    try {
      Deno.writeTextFileSync(
        `${dir.path}/crashes.test.ts`,
        [
          'Deno.test("starts", () => {',
          '  queueMicrotask(() => { throw new Error("boom-mid-run"); });',
          "});",
        ].join("\n"),
      );
      const { errors, value } = await runWithJUnitReport(dir, [
        "test",
        "--no-check",
        "-A",
        "--reporter=tap",
        "--junit-path",
        "junit.xml",
        "crashes.test.ts",
      ]);

      expect(value).not.toBe(0);
      says(
        errors.join("\n"),
        "\ndeno's JUnit report marks these files with uncaught errors:",
      );
      says(errors.join("\n"), "  ./crashes.test.ts");
    } finally {
      dir.dispose();
    }
  });

  test("does not name the files a stale report at the run's path holds", async () => {
    const dir: TempPath = tempDir();
    try {
      Deno.writeTextFileSync(
        `${dir.path}/junit.xml`,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<testsuites name="deno test" tests="1" failures="0" errors="1">',
          '    <testsuite name="./stale.test.ts" tests="1" errors="1" failures="0">',
          '        <testcase name="gone" classname="./stale.test.ts">',
          '            <error message="Cancelled"/>',
          "        </testcase>",
          "    </testsuite>",
          "</testsuites>",
        ].join("\n"),
      );
      const { errors, value } = await runWithJUnitReport(dir, [
        "eval",
        'Deno.test("fine", () => {}); Deno.exit(1);',
      ]);

      expect(value).not.toBe(0);
      assert(!errors.join("\n").includes("stale.test.ts"));
    } finally {
      dir.dispose();
    }
  });

  test("fails a filtered run that matched no test", async () => {
    const { code, logs } = await runOver('Deno.test("other test", () => {});', {
      nameFilter: "no such leaf",
    });

    expect(code).toBe(1);
    has(logs, "No test matched --filter no such leaf.");
  });

  test("fails a filtered run whose only matches are skipped tests", async () => {
    const { code, logs } = await runOver(
      'Deno.test("ignored", { ignore: true }, () => {});',
      { nameFilter: "ignored" },
    );

    expect(code).toBe(1);
    has(logs, "No test matched --filter ignored.");
  });

  test("passes a filtered run that matched a test", async () => {
    const { code, logs } = await runOver(
      'Deno.test("a matching test", () => {});',
      { nameFilter: "matching" },
    );

    expect(code).toBe(0);
    assert(!logs.join("\n").includes("No test matched"));
  });
});
