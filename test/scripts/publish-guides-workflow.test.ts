import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const WORKFLOW_PATH = ".github/workflows/publish-guides.yml";

describe("publish guide videos workflow", () => {
  test("accepts a pull request only when the caller asks", async () => {
    expectIncludesAll(await Deno.readTextFile(WORKFLOW_PATH), [
      "allow_pull_request:",
      "inputs.allow_pull_request && github.event_name == 'pull_request'",
    ]);
  });

  test("reads the preview CDN secrets when the generic names are absent", async () => {
    expectIncludesAll(await Deno.readTextFile(WORKFLOW_PATH), [
      "secrets.BUNNY_ACCESS_KEY || secrets.BUNNY_STAGING_ACCOUNT_KEY",
      "secrets.CDN_URL || secrets.CDN_STAGING_URL",
      "secrets.CDN_BUNNY_STORAGE_ZONE_NAME || secrets.CDN_BUNNY_STAGING_STORAGE_ZONE_NAME",
      "secrets.CDN_BUNNY_STORAGE_ZONE_KEY || secrets.CDN_BUNNY_STAGING_STORAGE_ZONE_KEY",
      "secrets.CDN_BUNNY_STORAGE_HOST || secrets.CDN_BUNNY_STAGING_STORAGE_HOST",
      "secrets.CDN_BUNNY_PULL_ZONE_ID || secrets.CDN_BUNNY_STAGING_PULL_ZONE_ID",
    ]);
  });

  test("captures the guide evidence before it publishes", async () => {
    const workflow = await Deno.readTextFile(WORKFLOW_PATH);

    expect(workflow).toContain("deno task guide:evidence");
    expect(workflow).not.toContain("deno task specs:evidence");
    expect(workflow.indexOf("deno task guide:evidence")).toBeLessThan(
      workflow.indexOf("deno task guide:publish"),
    );
  });
});
