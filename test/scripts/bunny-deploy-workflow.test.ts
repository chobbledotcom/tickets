import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

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

    for (const workflow of workflows) {
      expect(workflow).toContain("uses: ./.github/actions/deploy-bunny-script");
      expect(workflow).toContain(
        `api_key: ${githubValue("secrets.BUNNY_ACCESS_KEY")}`,
      );
      expect(workflow).not.toContain("BunnyWay/actions/deploy-script@main");
    }
  });

  test("restore deploy pins the external Bunny action to a commit SHA", async () => {
    const workflow = await readText(RESTORE_WORKFLOW_PATH);

    expect(workflow).toMatch(
      new RegExp(`uses: BunnyWay/actions/deploy-script@${SHA}`),
    );
    expect(workflow).not.toContain("BunnyWay/actions/deploy-script@main");
  });
});
