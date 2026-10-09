import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { runCompactDenoTest } from "#scripts/compact-test-reporter.ts";
import { capturingConsole } from "#test-utils/captured-console.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";

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

  /** Write a one-test file and run the compact reporter over it. */
  const runOver = async (
    body: string,
  ): Promise<{ code: number; logs: string[] }> => {
    const dir: TempPath = tempDir();
    try {
      Deno.writeTextFileSync(`${dir.path}/sample.test.ts`, body);
      const { errors, logs, value } = await capturingConsole(() =>
        runCompactDenoTest(
          ["test", "--no-check", "-A", "--reporter=tap", "sample.test.ts"],
          { cwd: dir.path, env: { CI: "1" } },
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
    expect(logs).toContain("Running tests...");
    expect(logs).toContain("\nPASS 1 passed");
    // CI in the environment hides the progress bar.
    expect(logs).toContain("ok   works");
  });

  test("reports a failing file and exits with its code", async () => {
    const { code, logs } = await runOver(
      'Deno.test("breaks", () => { throw new Error("nope"); });',
    );

    expect(code).not.toBe(0);
    expect(logs).toContain("\nFAILED 0 passed, 1 failed");
    expect(logs.join("\n")).toContain("nope");
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
      expect(errors.join("\n")).toContain(
        "error: Uncaught boom from the dying child",
      );
      expect(errors.join("\n")).toContain("deno exited with code 1");
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
      expect(errors.join("\n")).toContain(
        "\ndeno's JUnit report marks these files with uncaught errors:",
      );
      expect(errors.join("\n")).toContain("  ./crashes.test.ts");
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
      expect(errors.join("\n")).not.toContain("stale.test.ts");
    } finally {
      dir.dispose();
    }
  });
});
