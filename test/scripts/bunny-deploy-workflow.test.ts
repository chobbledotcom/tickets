import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { map } from "#fp";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const DEPLOY_ACTION_PATH = ".github/actions/deploy-bunny-script/action.yml";
const BUNNY_DEPLOY_WORKFLOW_PATHS = [
  ".github/workflows/bunny-deploy.yml",
  ".github/workflows/production-deploy.yml",
] as const;
const MAIN_INSTANCE_KEY_WORKFLOW_PATHS = [
  ...BUNNY_DEPLOY_WORKFLOW_PATHS,
  ".github/workflows/deploy-clients.yml",
] as const;
const RESTORE_WORKFLOW_PATH = ".github/workflows/restore-deploy.yml";
const SHA = "[a-f0-9]{40}";
/** The quoted path the action grants read permission for. */
const ALLOW_READ_PATH = /--allow-read="([^"]+)"/;
/** The quoted file argument the action hands the deploy script. */
const SCRIPT_FILE_ARG = /deploy-built-edge\.ts\s+"[^"]+"\s+"([^"]+)"/;

const readText = (path: string): Promise<string> => Deno.readTextFile(path);
const githubValue = (name: string): string =>
  ["$", "{{ ", name, " }}"].join("");

describe("Bunny deploy workflow", () => {
  test("deploys built bundles through first-party code", async () => {
    const action = await readText(DEPLOY_ACTION_PATH);

    expectIncludesAll(action, [
      "scripts/deploy-built-edge.ts",
      "--allow-net=api.bunny.net",
      `BUNNY_ACCESS_KEY: ${githubValue("inputs.api_key")}`,
    ]);
    assert(!action.includes("BunnyWay/actions/deploy-script@main"));
    expect(action).not.toMatch(/uses:\s+BunnyWay\/actions\/deploy-script@/);
  });

  test("staging and production keep the deploy key in a repository action", async () => {
    const workflows = await Promise.all(
      BUNNY_DEPLOY_WORKFLOW_PATHS.map(readText),
    );

    const expected = {
      omitsMutableBunnyRef: true,
      passesAccessKey: true,
      usesRepositoryAction: true,
    };

    const checks = map((workflow: string) => ({
      omitsMutableBunnyRef: !workflow.includes(
        "BunnyWay/actions/deploy-script@main",
      ),
      passesAccessKey: workflow.includes(
        `api_key: ${githubValue("secrets.BUNNY_ACCESS_KEY")}`,
      ),
      usesRepositoryAction: workflow.includes(
        "uses: $/.github/actions/deploy-bunny-script",
      ),
    }))(workflows);

    expect(checks).toEqual(workflows.map(() => expected));
  });

  test("grants read permission for the same trimmed path it passes to the script", async () => {
    const action = await readText(DEPLOY_ACTION_PATH);
    const lines = action.split("\n").map((line) => line.trim());

    const allowRead = lines
      .find((line) => line.startsWith("--allow-read="))!
      .match(ALLOW_READ_PATH)![1]!;
    const scriptFileArg = lines
      .find((line) => line.startsWith("scripts/deploy-built-edge.ts"))!
      .match(SCRIPT_FILE_ARG)![1]!;

    // parseDeployBuiltArgs trims the file internally, so the action must hand the
    // script an already-trimmed path and grant the read permission for that same
    // path — otherwise a padded `file:` input leaves Deno denying its own read.
    expect(allowRead).not.toMatch(/BUNNY_SCRIPT_FILE/);
    expect(scriptFileArg).toBe(allowRead);
  });

  // GitHub writes a step's env, run inputs included, to the public job log
  // before any mask applies. Only a secret stays masked.
  test("every deploy workflow reads MAIN_INSTANCE_KEY from secrets only", async () => {
    const workflows = await Promise.all(
      MAIN_INSTANCE_KEY_WORKFLOW_PATHS.map(readText),
    );

    const checks = map((workflow: string) => ({
      readsKeyFromInputs: workflow.includes("inputs.main_instance_key"),
      readsKeyFromSecrets: workflow.includes(
        githubValue("secrets.MAIN_INSTANCE_KEY"),
      ),
    }))(workflows);

    expect(checks).toEqual(
      workflows.map(() => ({
        readsKeyFromInputs: false,
        readsKeyFromSecrets: true,
      })),
    );
  });

  test("restore deploy pins the external Bunny action to a commit SHA", async () => {
    const workflow = await readText(RESTORE_WORKFLOW_PATH);

    expect(workflow).toMatch(
      new RegExp(`uses: BunnyWay/actions/deploy-script@${SHA}`),
    );
    assert(!workflow.includes("BunnyWay/actions/deploy-script@main"));
  });
});
