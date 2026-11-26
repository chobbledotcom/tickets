import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const WORKFLOW_PATH = ".github/workflows/preview.yml";

/** Every secret the workflow may read. All of them live in the `preview`
 * environment. The list has no production secret. */
const PREVIEW_SECRETS = [
  "BUNNY_STAGING_ACCOUNT_KEY",
  "CDN_BUNNY_STAGING_PULL_ZONE_ID",
  "CDN_BUNNY_STAGING_STORAGE_HOST",
  "CDN_BUNNY_STAGING_STORAGE_ZONE_KEY",
  "CDN_BUNNY_STAGING_STORAGE_ZONE_NAME",
  "CDN_STAGING_URL",
  "HOST_EMAIL_API_KEY",
  "HOST_EMAIL_FROM_ADDRESS",
  "HOST_EMAIL_PROVIDER",
  "STAGING_STORAGE_ZONE_KEY",
  "STAGING_STORAGE_ZONE_NAME",
];

/** A GitHub expression, built without a template placeholder in the source. */
const githubValue = (expression: string): string =>
  ["$", "{{ ", expression, " }}"].join("");

const readWorkflow = (): Promise<string> => Deno.readTextFile(WORKFLOW_PATH);

const codeOf = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

/** The text of one job, from its key to the next job. */
const jobText = (text: string, name: string): string => {
  const jobs = codeOf(text).split(/^jobs:\n/m)[1] ?? "";
  const block = jobs
    .split(/^ {2}(?=[\w-]+:)/m)
    .find((job) => job.startsWith(`${name}:`));
  if (block === undefined) throw new Error(`The workflow has no ${name} job`);
  return block;
};

describe("preview workflow", () => {
  test("runs on the events of a pull request", async () => {
    expectIncludesAll(await readWorkflow(), [
      "pull_request:",
      "types: [opened, reopened, synchronize, closed]",
    ]);
  });

  test("runs one job at a time for each branch and never cancels a run", async () => {
    const text = await readWorkflow();

    expect(text).toMatch(
      /concurrency:\n {2}group: preview-\$\{\{ github\.event\.pull_request\.head\.ref \}\}\n {2}cancel-in-progress: false\n/,
    );
  });

  test("gives a fork no preview", async () => {
    const check = jobText(await readWorkflow(), "check");

    expect(check).toContain(
      `if: ${githubValue("github.event.pull_request.head.repo.full_name == github.repository")}`,
    );
  });

  test("makes no new preview for a pull request that is closed by the time the run starts", async () => {
    const text = await readWorkflow();
    const deploy = jobText(text, "deploy");

    expectIncludesAll(jobText(text, "check"), [
      'gh api "repos/$REPOSITORY/pulls/$PULL_REQUEST" --jq .state',
    ]);
    expectIncludesAll(deploy, [
      "needs: check",
      "github.event.action != 'closed'",
      "needs.check.outputs.open == 'true'",
    ]);
  });

  test("deletes the preview of a closed pull request, merged or not", async () => {
    const cleanup = jobText(await readWorkflow(), "cleanup");

    expectIncludesAll(cleanup, [
      `if: ${githubValue("github.event.action == 'closed'")}`,
      `ref: ${githubValue("github.event.pull_request.head.sha")}`,
      'scripts/preview.ts remove "$BRANCH"',
    ]);
  });

  test("names the preview environment in each job that reads a secret", async () => {
    const text = await readWorkflow();

    expect(jobText(text, "cleanup")).toMatch(/^ {4}environment: preview$/m);
    expect(jobText(text, "check")).not.toContain("secrets.");
  });

  test("links the deployment of each preview to its address", async () => {
    const deploy = jobText(await readWorkflow(), "deploy");

    expectIncludesAll(deploy, [
      "    environment:\n      name: preview\n",
      `      url: ${githubValue("steps.preview.outputs.site_url")}\n`,
    ]);
  });

  test("reads only the preview secrets", async () => {
    const names = [
      ...codeOf(await readWorkflow()).matchAll(/\bsecrets\.([A-Z_]+)/g),
    ].map(([, name]) => name);

    expect(unique(names).sort()).toEqual(PREVIEW_SECRETS);
  });

  test("never reads the key that serves the fleet or the production Bunny key", async () => {
    const text = codeOf(await readWorkflow());

    for (const name of [
      "MAIN_INSTANCE_KEY",
      "MAIN_INSTANCE",
      "BUNNY_ACCESS_KEY }}",
      "BUNNY_SCRIPT_ID",
    ]) {
      expect(text).not.toContain(`secrets.${name}`);
    }
  });

  test("hands the branch name to each script through the environment", async () => {
    const text = codeOf(await readWorkflow());

    expect(
      text.match(/BRANCH: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/g),
    ).toHaveLength(2);
    expect(text).not.toMatch(/scripts\/preview\.ts \w+ "?\$\{\{/);
  });

  test("checks the secrets before the build and deploys an old preview through the update-mode action", async () => {
    const deploy = jobText(await readWorkflow(), "deploy");

    expect(deploy.indexOf("Check the secrets this run needs")).toBeLessThan(
      deploy.indexOf("uses: $/.github/actions/build-bunny-script"),
    );
    expectIncludesAll(deploy, [
      "scripts/ci/require-env.sh",
      "scripts/ci/check-credentials.sh bunny cdn-zone",
      `if: ${githubValue("steps.preview.outputs.published == 'false'")}`,
      "uses: $/.github/actions/deploy-bunny-script",
    ]);
  });
});
