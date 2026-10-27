import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * scripts/ci/deno-install.sh is the one install policy for CI and the
 * container image. These tests run the script against a stub deno
 * executable. They pin the arguments it passes: one install call, a frozen
 * lockfile, and an --allow-scripts list that names every package whose
 * lifecycle scripts deno.lock records. A failed install must fail the
 * script, so the CI step fails.
 */

const scriptPath = join(projectRoot, "scripts", "ci", "deno-install.sh");

const lockfileScriptedPackages = async (): Promise<string[]> => {
  const lock = JSON.parse(
    await Deno.readTextFile(join(projectRoot, "deno.lock")),
  ) as { npm: Record<string, { scripts?: boolean }> };
  return unique(
    Object.keys(lock.npm)
      .filter((key) => lock.npm[key]?.scripts === true)
      .map((key) => key.replace(/@[^@]+$/, "")),
  ).sort();
};

const runInstallScript = async (
  stubExitCode: number,
): Promise<{ calls: string[][]; success: boolean }> => {
  const binDir = await Deno.makeTempDir({ prefix: "deno-install-stub-" });
  const callsFile = join(binDir, "calls");
  try {
    await Deno.writeTextFile(
      join(binDir, "deno"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "${callsFile}"`,
        `exit ${stubExitCode}`,
      ].join("\n"),
    );
    await Deno.chmod(join(binDir, "deno"), 0o755);
    const command = new Deno.Command("bash", {
      args: [scriptPath],
      cwd: projectRoot,
      // The stub directory comes first, so the script cannot reach a real
      // deno installed on the machine running the suite.
      env: { PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}` },
      stderr: "piped",
      stdout: "piped",
    });
    const output = await command.output();
    const calls = (await Deno.readTextFile(callsFile))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(" "));
    return { calls, success: output.success };
  } finally {
    await Deno.remove(binDir, { recursive: true });
  }
};

const expectedInstallCall = [
  "install",
  "--frozen",
  `--allow-scripts=${(await lockfileScriptedPackages())
    .map((name) => `npm:${name}`)
    .join(",")}`,
];

describe("the shared dependency install policy", () => {
  test("installs once with a frozen lockfile and the scripted packages from deno.lock", async () => {
    const { calls, success } = await runInstallScript(0);
    expect(success).toBe(true);
    expect(calls).toEqual([expectedInstallCall]);
  });

  test("fails when the install fails", async () => {
    const { calls, success } = await runInstallScript(1);
    expect(success).toBe(false);
    expect(calls).toEqual([expectedInstallCall]);
  });
});
