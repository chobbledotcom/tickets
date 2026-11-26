import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import {
  configureSite,
  type Pace,
  type SitePlan,
} from "#scripts/preview/configure.ts";
import { createSiteClient } from "#scripts/preview/site-client.ts";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { createTestDb, describeWithEnv, resetDb } from "#test-utils/db.ts";

const ORIGIN = "http://localhost";

/** The providers that the test app can save. Stripe sets up a webhook at
 * Stripe, and the test Stripe server does not accept that call. */
const PLAN: SitePlan = {
  owner: { password: "a-shared-preview-password", username: "preview-owner" },
  providers: [
    {
      fields: {
        sumupApiKey: "sumup-sandbox-key",
        sumupMerchantCode: "MPREVIEW1",
      },
      id: "sumup",
    },
    {
      fields: {
        squareAccessToken: "EAAAsandboxtoken1234567890",
        squareLocationId: "LPREVIEW1",
        squareSandbox: "on",
      },
      id: "square",
    },
  ],
};

const PACE: Pace = {
  attempts: 3,
  delayMs: 1000,
  sleep: () => Promise.resolve(),
};

const configure = () =>
  configureSite(createSiteClient(ORIGIN, inProcess), PLAN, PACE);

describeWithEnv(
  "preview setup against the app",
  { encryptionKey: true },
  () => {
    beforeEach(createTestDb);
    afterEach(resetDb);

    test("sets up a new site, signs in, and saves each provider", async () => {
      expect(await configure()).toEqual({
        ok: true,
        value: ["Setup completed.", "sumup configured.", "square configured."],
      });

      const owner = createApp(inProcess);
      await owner.logIn(PLAN.owner.username, PLAN.owner.password);
      const settings = (await owner.get("/admin/settings")).html;
      expect(settings).toContain('id="square-test-btn"');
    });

    test("leaves a site that a person already set up as it is", async () => {
      const person = createApp(inProcess);
      await person.submit("/setup/", {
        acceptAgreement: "yes",
        adminPassword: "another-password-1",
        adminPasswordConfirm: "another-password-1",
        adminUsername: "someone-else",
      });

      expect(await configure()).toEqual({
        ok: true,
        value: ["Setup was already complete, so the site was left as it is."],
      });
      await person.logIn("someone-else", "another-password-1");
      const settings = (await person.get("/admin/settings")).html;
      expect(settings).not.toContain("-test-btn");
    });

    test("leaves a site as it is on a second pass", async () => {
      await configure();

      expect(await configure()).toEqual({
        ok: true,
        value: ["Setup was already complete, so the site was left as it is."],
      });
    });
  },
);
