import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const WORKFLOW_PATH = ".github/workflows/publish-guides.yml";
const ACTION_PATH = ".github/actions/publish-guide-videos/action.yml";
const DEPLOY_WORKFLOWS = [
  ".github/workflows/preview.yml",
  ".github/workflows/bunny-deploy.yml",
  ".github/workflows/production-deploy.yml",
  ".github/workflows/release.yml",
  ".github/workflows/deploy-clients.yml",
];

describe("publish guide videos", () => {
  test("the manual workflow runs the shared action in the chosen environment", async () => {
    const workflow = await Deno.readTextFile(WORKFLOW_PATH);

    expect(workflow).toMatch(/environment: \$\{\{ inputs\.environment \}\}/);
    expectIncludesAll(workflow, [
      "uses: $/.github/actions/publish-guide-videos",
      "secrets.BUNNY_ACCESS_KEY",
      "secrets.CDN_URL",
    ]);
  });

  test("the action captures the guide evidence before it publishes", async () => {
    const action = await Deno.readTextFile(ACTION_PATH);

    expect(action).toContain("deno task guide:evidence");
    expect(action).toContain("deno task guide:publish");
    expect(action).toContain("guide_videos:");
    expect(action.indexOf("deno task guide:evidence")).toBeLessThan(
      action.indexOf("deno task guide:publish"),
    );
  });

  for (const path of DEPLOY_WORKFLOWS) {
    test(`${path} publishes the guide videos before its build`, async () => {
      const workflow = await Deno.readTextFile(path);

      expect(workflow).toContain(
        "uses: $/.github/actions/publish-guide-videos",
      );
      expect(workflow).toContain("steps.guides.outputs.guide_videos");
      expect(workflow).not.toContain("guide-videos:");
      expect(workflow.indexOf("name: Publish guide videos")).toBeLessThan(
        workflow.indexOf("uses: $/.github/actions/build-bunny-script"),
      );
    });
  }
});
