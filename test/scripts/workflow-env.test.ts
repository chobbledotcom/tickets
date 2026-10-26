import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { STRIPE_MOCK_VERSION } from "#scripts/stripe-mock/install.ts";

/** Every workflow that runs the test harness and caches `.bin`. */
const WORKFLOWS = [
  ".github/workflows/test.yml",
  ".github/workflows/production-suite.yml",
];

describe("workflow stripe-mock version", () => {
  test("names the release the harness pins", async () => {
    // A workflow caches `.bin` under the version its env names. When the
    // harness pin moves and a workflow env lags, the cache restores the old
    // binary and the harness uses it as-is, so the suite quietly runs the
    // wrong stripe-mock. Each workflow must name the pinned release.
    for (const path of WORKFLOWS) {
      const workflow = await Deno.readTextFile(path);
      expect(
        workflow,
        `${path} must set STRIPE_MOCK_VERSION: "${STRIPE_MOCK_VERSION}"`,
      ).toContain(`STRIPE_MOCK_VERSION: "${STRIPE_MOCK_VERSION}"`);
    }
  });
});
