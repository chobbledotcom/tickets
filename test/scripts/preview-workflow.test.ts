import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { unique } from "#fp";
import { readCopiedSecrets } from "#scripts/preview/copied-secrets.ts";
import { readSitePlan, readStripeKey } from "#scripts/preview/site-plan.ts";
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
  "PREVIEW_OWNER_PASSWORD",
  "PREVIEW_OWNER_USERNAME",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "STAGING_STORAGE_ZONE_KEY",
  "STAGING_STORAGE_ZONE_NAME",
  "STRIPE_SECRET_KEY",
  "SUMUP_API_KEY",
  "SUMUP_MERCHANT_CODE",
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

/** The text of one step of a job, from its name to the next step. */
const stepText = (job: string, name: string): string => {
  const step = job
    .split(/^ {6}- (?=name: )/m)
    .find((text) => text.startsWith(`name: ${name}\n`));
  if (step === undefined) throw new Error(`The job has no step ${name}`);
  return step;
};

/** The variables that name the Bunny key. The key has another secret name. */
const BUNNY_KEYS = ["BUNNY_ACCESS_KEY", "BUNNY_API_KEY"];

type ReadNames = (getEnv: (key: string) => string | undefined) => unknown;

/** A step that runs a preview script: its job, its name, the reader of its
 * variables, and the variables that the reader does not ask for. */
const SCRIPT_STEPS: [
  job: string,
  name: string,
  readNames: ReadNames,
  keys: string[],
][] = [
  ["deploy", "Create or complete the preview", readCopiedSecrets, BUNNY_KEYS],
  ["deploy", "Set up the preview", readSitePlan, []],
  ["cleanup", "Delete the preview", readStripeKey, BUNNY_KEYS],
];

/** The variable names that a reader asks for. */
const requestedBy = (read: ReadNames): string[] => {
  const asked: string[] = [];
  read((name) => {
    asked.push(name);
    return "";
  });
  return asked;
};

/** The sorted variable names that a step lets `deno run` read. */
const allowedEnv = (step: string): string[] =>
  (step.match(/--allow-env=(\S+)/)?.[1] ?? "").split(",").sort();

describe("preview workflow", () => {
  test("sets up a new preview after the deploy, and reaches only the preview", async () => {
    const deploy = jobText(await readWorkflow(), "deploy");
    const setup = stepText(deploy, "Set up the preview");

    expect(deploy.indexOf("name: Set up the preview")).toBeGreaterThan(
      deploy.indexOf("name: Deploy the build to the existing preview"),
    );
    expectIncludesAll(setup, [
      'site_hosts="$(deno run scripts/update-mode-hosts.ts "$SITE_URL")"',
      '--allow-net="$site_hosts"',
      'scripts/preview.ts configure "$SITE_URL"',
    ]);
    expect(setup).not.toContain("api.bunny.net");
    expect(setup).not.toContain("BUNNY_");
  });

  test("deletes the Stripe webhooks when it deletes the preview", async () => {
    const cleanup = jobText(await readWorkflow(), "cleanup");

    expectIncludesAll(stepText(cleanup, "Delete the preview"), [
      "--allow-env=BUNNY_ACCESS_KEY,BUNNY_API_KEY,STRIPE_SECRET_KEY",
      "--allow-net=api.bunny.net,api.stripe.com",
      'scripts/preview.ts remove "$BRANCH"',
    ]);
    expect(stepText(cleanup, "Check the secrets this run needs")).toContain(
      "scripts/ci/require-env.sh BUNNY_ACCESS_KEY STRIPE_SECRET_KEY",
    );
  });

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

  for (const [job, name, readNames, keys] of SCRIPT_STEPS) {
    test(`lets "${name}" read exactly the variables that its code asks for, each from a secret`, async () => {
      const step = stepText(jobText(await readWorkflow(), job), name);
      const asked = requestedBy(readNames);

      expect(allowedEnv(step)).toEqual([...keys, ...asked].sort());
      for (const variable of asked) {
        expect(step).toContain(
          `          ${variable}: ${githubValue(`secrets.${variable}`)}\n`,
        );
      }
    });
  }

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
