import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * The deploy workflows run scripts/ci/require-env.sh before the build, so a
 * missing secret stops the run at once. The script runs before devenv exists,
 * so it is bash, and these tests run it with an environment of their own.
 */

const scriptPath = join(projectRoot, "scripts", "ci", "require-env.sh");

type Outcome = { code: number; stderr: string[]; stdout: string };

const lines = (bytes: Uint8Array): string[] =>
  new TextDecoder().decode(bytes).split("\n").filter(Boolean);

const check = async (
  env: Record<string, string>,
  args: string[],
): Promise<Outcome> => {
  const result = await new Deno.Command("bash", {
    args: [scriptPath, ...args],
    clearEnv: true,
    env: { PATH: Deno.env.get("PATH") ?? "", ...env },
    stderr: "piped",
    stdout: "piped",
  }).output();
  return {
    code: result.code,
    stderr: lines(result.stderr),
    stdout: lines(result.stdout).join("\n"),
  };
};

const passed: Outcome = {
  code: 0,
  stderr: [],
  stdout: "Every value that this run needs is set.",
};

const failed = (...problems: string[]): Outcome => ({
  code: 1,
  stderr: problems.map((problem) => `::error::${problem}`),
  stdout: "",
});

describe("the workflow secret check", () => {
  test("passes when every named value is set", async () => {
    expect(await check({ KEY: "a", URL: "b" }, ["KEY", "URL"])).toEqual(passed);
  });

  test("names every missing value, not only the first", async () => {
    expect(await check({ URL: "b" }, ["KEY", "URL", "TOKEN"])).toEqual(
      failed("KEY is not set.", "TOKEN is not set."),
    );
  });

  test("counts a blank value as not set", async () => {
    expect(await check({ KEY: " \t" }, ["KEY"])).toEqual(
      failed("KEY is not set."),
    );
  });

  test("--if requires its list only when the name is set", async () => {
    const args = ["--if", "BACKUP", "ZONE,ZONE_KEY"];
    expect(await check({}, args)).toEqual(passed);
    expect(await check({ BACKUP: "yes", ZONE: "z" }, args)).toEqual(
      failed("ZONE_KEY is not set, and BACKUP needs it."),
    );
    expect(
      await check({ BACKUP: "yes", ZONE: "z", ZONE_KEY: "k" }, args),
    ).toEqual(passed);
  });

  test("--unless requires its list only when the name is not set", async () => {
    const args = ["--unless", "KEY", "SITE_URL"];
    expect(await check({ KEY: "a" }, args)).toEqual(passed);
    expect(await check({}, args)).toEqual(
      failed("SITE_URL is not set, and a run with no KEY needs it."),
    );
    expect(await check({ SITE_URL: "https://a.example" }, args)).toEqual(
      passed,
    );
  });

  test("--together accepts all of a group or none of it", async () => {
    const args = ["--together", "CDN_URL,CDN_ZONE,CDN_KEY"];
    expect(await check({}, args)).toEqual(passed);
    expect(
      await check({ CDN_KEY: "k", CDN_URL: "u", CDN_ZONE: "z" }, args),
    ).toEqual(passed);
    expect(await check({ CDN_URL: "u" }, args)).toEqual(
      failed(
        "Set all of CDN_URL CDN_ZONE CDN_KEY or none of them. Not set: CDN_ZONE CDN_KEY.",
      ),
    );
  });

  test("reports the problems of every rule in one run", async () => {
    const outcome = await check({ A: "1", CDN_URL: "u" }, [
      "KEY",
      "--if",
      "A",
      "B",
      "--together",
      "CDN_URL,CDN_KEY",
    ]);

    expect(outcome).toEqual(
      failed(
        "KEY is not set.",
        "B is not set, and A needs it.",
        "Set all of CDN_URL CDN_KEY or none of them. Not set: CDN_KEY.",
      ),
    );
  });

  test("refuses a rule it does not know or cannot read", async () => {
    expect(await check({}, ["--sometimes", "KEY"])).toEqual({
      code: 2,
      stderr: ["Unknown option: --sometimes"],
      stdout: "",
    });
    expect(await check({}, ["--if", "KEY"])).toEqual({
      code: 2,
      stderr: ["--if needs a name and a list"],
      stdout: "",
    });
    expect(await check({}, ["--together"])).toEqual({
      code: 2,
      stderr: ["--together needs a list"],
      stdout: "",
    });
  });
});
