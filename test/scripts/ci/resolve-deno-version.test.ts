import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * The setup-devenv action resolves the Deno version through
 * scripts/ci/resolve-deno-version.sh, before the dependency cache exists. The
 * script retries because a cold eval can fail once on an ephemeral runner.
 * These tests stand a stub devenv in for the real CLI: the stub fails its
 * first N calls, then reports a version. They pin how many calls the script
 * makes, what it passes to devenv, and what it writes to $GITHUB_OUTPUT.
 */

const scriptPath = join(
  projectRoot,
  "scripts",
  "ci",
  "resolve-deno-version.sh",
);

type StubbedDevenv = {
  /** Directory with the fake devenv executable on PATH. */
  binDir: string;
  /** File the stub counts its calls in. */
  callsFile: string;
  /** File the stub writes the arguments of its latest call to. */
  argsFile: string;
};

const makeStubbedDevenv = async (
  succeedOnCall: number,
): Promise<StubbedDevenv> => {
  const binDir = await Deno.makeTempDir({ prefix: "resolve-stub-" });
  const callsFile = join(binDir, "calls");
  const argsFile = join(binDir, "args");
  const stubLines = [
    "#!/usr/bin/env bash",
    `count="$(( $(cat "${callsFile}" 2>/dev/null || echo 0) + 1 ))"`,
    `echo "$count" > "${callsFile}"`,
    `printf '%s\\n' "$*" > "${argsFile}"`,
    `if [ "$count" -lt "${succeedOnCall}" ]; then`,
    `  echo "simulated torn cold eval" >&2`,
    "  exit 1",
    "fi",
    `echo "deno 9.9.9 (stub)"`,
  ];
  await Deno.writeTextFile(join(binDir, "devenv"), stubLines.join("\n"));
  await Deno.chmod(join(binDir, "devenv"), 0o755);
  return { argsFile, binDir, callsFile };
};

const runResolve = async (stub: StubbedDevenv): Promise<Deno.CommandOutput> => {
  const command = new Deno.Command("bash", {
    args: [scriptPath, "ci"],
    cwd: projectRoot,
    env: {
      GITHUB_OUTPUT: join(stub.binDir, "github-output"),
      // The stub directory comes first, so `devenv` inside the script cannot
      // reach a real devenv installed on the machine running the suite.
      PATH: `${stub.binDir}:${Deno.env.get("PATH") ?? ""}`,
      RESOLVE_RETRY_SLEEP: "0",
    },
    stderr: "piped",
    stdout: "piped",
  });
  return command.output();
};

const expectResolved = async (succeedOnCall: number): Promise<void> => {
  const stub = await makeStubbedDevenv(succeedOnCall);
  try {
    const result = await runResolve(stub);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.success, `script exited ${result.code}: ${stderr}`).toBe(
      true,
    );
    expect(await Deno.readTextFile(stub.callsFile)).toBe(`${succeedOnCall}\n`);
    expect(await Deno.readTextFile(stub.argsFile)).toBe(
      "--profile ci shell -- deno --version\n",
    );
    expect(await Deno.readTextFile(join(stub.binDir, "github-output"))).toBe(
      "version=9.9.9\n",
    );
  } finally {
    await Deno.remove(stub.binDir, { recursive: true });
  }
};

describe("the setup-devenv Deno version resolve", () => {
  test("succeeds when the first eval works", () => expectResolved(1));

  test("succeeds when the second eval works, after one torn cold eval", () =>
    expectResolved(2));

  test("fails after three torn cold evals", async () => {
    const stub = await makeStubbedDevenv(4);
    try {
      const result = await runResolve(stub);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.success, `script exited ${result.code}: ${stderr}`).toBe(
        false,
      );
      expect(result.code, `script stderr: ${stderr}`).toBe(1);
      expect(await Deno.readTextFile(stub.callsFile)).toBe("3\n");
      expect(stderr).toContain("resolve attempt 3 failed; retrying");
    } finally {
      await Deno.remove(stub.binDir, { recursive: true });
    }
  });
});
