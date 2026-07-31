import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { map } from "#fp";

const DEPLOY_ACTION_PATH = ".github/actions/deploy-bunny-script/action.yml";
const BUNNY_DEPLOY_WORKFLOW_PATHS = [
  ".github/workflows/bunny-deploy.yml",
  ".github/workflows/production-deploy.yml",
] as const;
const RESTORE_WORKFLOW_PATH = ".github/workflows/restore-deploy.yml";
const SHA = "[a-f0-9]{40}";

const readText = (path: string): Promise<string> => Deno.readTextFile(path);
const githubValue = (name: string): string =>
  ["$", "{{ ", name, " }}"].join("");

describe("Bunny deploy workflow", () => {
  test("deploys built bundles through first-party code", async () => {
    const action = await readText(DEPLOY_ACTION_PATH);

    expect(action).toContain("scripts/deploy-built-edge.ts");
    expect(action).toContain("--allow-net=api.bunny.net");
    expect(action).toContain(
      `BUNNY_ACCESS_KEY: ${githubValue("inputs.api_key")}`,
    );
    expect(action).not.toContain("BunnyWay/actions/deploy-script@main");
    expect(action).not.toMatch(/uses:\s+BunnyWay\/actions\/deploy-script@/);
  });

  test("staging and production keep the deploy key in the local wrapper", async () => {
    const workflows = await Promise.all(
      BUNNY_DEPLOY_WORKFLOW_PATHS.map(readText),
    );

    const expected = {
      omitsMutableBunnyRef: true,
      passesAccessKey: true,
      usesLocalAction: true,
    };

    const checks = map((workflow: string) => ({
      omitsMutableBunnyRef: !workflow.includes(
        "BunnyWay/actions/deploy-script@main",
      ),
      passesAccessKey: workflow.includes(
        `api_key: ${githubValue("secrets.BUNNY_ACCESS_KEY")}`,
      ),
      usesLocalAction: workflow.includes(
        "uses: ./.github/actions/deploy-bunny-script",
      ),
    }))(workflows);

    expect(checks).toEqual(workflows.map(() => expected));
  });

  test("grants read permission for the same trimmed path it passes to the script", async () => {
    const action = await readText(DEPLOY_ACTION_PATH);
    const lines = action.split("\n").map((line) => line.trim());

    const allowRead = lines
      .find((line) => line.startsWith("--allow-read="))!
      .match(/--allow-read="([^"]+)"/)![1]!;
    const scriptFileArg = lines
      .find((line) => line.startsWith("scripts/deploy-built-edge.ts"))!
      .match(/deploy-built-edge\.ts\s+"[^"]+"\s+"([^"]+)"/)![1]!;

    // parseDeployBuiltArgs trims the file internally, so the action must hand the
    // script an already-trimmed path and grant the read permission for that same
    // path — otherwise a padded `file:` input leaves Deno denying its own read.
    expect(allowRead).not.toMatch(/BUNNY_SCRIPT_FILE/);
    expect(scriptFileArg).toBe(allowRead);
  });

  test("restore deploy pins the external Bunny action to a commit SHA", async () => {
    const workflow = await readText(RESTORE_WORKFLOW_PATH);

    expect(workflow).toMatch(
      new RegExp(`uses: BunnyWay/actions/deploy-script@${SHA}`),
    );
    expect(workflow).not.toContain("BunnyWay/actions/deploy-script@main");
  });
});
