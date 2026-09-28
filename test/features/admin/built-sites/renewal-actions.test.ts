import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { updateBuiltSiteRenewalState } from "#db/built-sites.ts";
import { renewalPanelFor } from "#templates/admin/built-sites/renewal-panels.tsx";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  provisionTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";
import {
  findSite,
  renewalSuiteHelpers,
  secretNamesOf,
  siteAction,
} from "./renewal-setup.ts";

describeWithEnv(
  "admin built-sites renewal actions",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = renewalSuiteHelpers();

    /** Assert override-deadline rejects `date` without changing state or pushing. */
    const expectOverrideRejected = async (
      scriptId: string,
      siteName: string,
      date: string,
    ): Promise<void> => {
      const site = await createTestBuiltSite({
        hostingId: scriptId,
        name: siteName,
      });
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2027-01-01T00:00:00Z",
      });
      const { response } = await siteAction(site, "override-deadline", {
        date,
      });
      await expectFlashRedirect(
        `/admin/built-sites/${site.id}/renewal`,
        "Choose a valid deadline date",
        false,
      )(response);
      const updated = await findSite(site.id);
      expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
      expect(suite.secretStub.calls.length).toBe(0);
    };
    describe("POST /admin/built-sites/:id/rotate-renewal-token", () => {
      test("refuses to rotate while the token is reserved unconfirmed", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6044",
          name: "Reserved Not Confirmed",
        });
        // Reserve the token with the cutoff left empty — the state the
        // assignment recovery is re-pushing right now.
        await provisionTestBuiltSite(site.id, { readOnlyFrom: "" });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-renewal-token`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal is not provisioned for this site",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe("");
      });

      test("rotates token on a provisioned site and pushes new RENEWAL_URL", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6001",
          name: "Rotate Site",
        });
        const { token: oldToken } = await provisionTestBuiltSite(site.id);

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-renewal-token`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal token rotated",
        )(response);

        const updated = await findSite(site.id);
        expect(updated.renewalToken).not.toBe(oldToken);
        expect(updated.renewalToken).not.toBeNull();
        expect(updated.renewalTokenIndex).not.toBeNull();

        // Rotate only re-pushes RENEWAL_URL, not READ_ONLY_FROM.
        const secretNames = secretNamesOf(suite.secretStub);
        expect(secretNames).toContain("RENEWAL_URL");
        expect(secretNames).not.toContain("READ_ONLY_FROM");

        const logs = await getAllActivityLog();
        expect(
          logs.some((l) => l.message.includes("Rotated renewal token")),
        ).toBe(true);
      });

      test("redirects on unprovisioned site (no-op)", async () => {
        const site = await createTestBuiltSite({
          name: "Unprovisioned Rotate",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/rotate-renewal-token`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal is not provisioned for this site",
          false,
        )(response);

        expect(suite.secretStub.calls.length).toBe(0);
      });

      test("shows the exact error when the replacement token cannot be pushed", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6002",
          name: "Rotate Failure",
        });
        await provisionTestBuiltSite(site.id);

        await suite.withFailingSecretStub(async () => {
          const { response } = await siteAction(site, "rotate-renewal-token");
          await expectFlashRedirect(
            `/admin/built-sites/${site.id}/renewal`,
            "Renewal token could not be pushed to the site",
            false,
          )(response);
        });
      });
    });

    describe("POST /admin/built-sites/:id/override-deadline", () => {
      test("accepts a future date and pushes it", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6020",
          name: "Override Site",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/override-deadline`,
          { date: "2027-06-15" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Deadline updated",
        )(response);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe("2027-06-15T23:59:59Z");
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain(
          "Admin overrode 'Override Site' deadline to 2027-06-15T23:59:59Z",
        );
      });

      test("works without a renewal token", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6021",
          name: "Override No Token",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/override-deadline`,
          { date: "2027-12-01" },
        );
        expect(response.status).toBe(302);

        const secretNames = secretNamesOf(suite.secretStub);
        expect(secretNames).not.toContain("RENEWAL_URL");
      });

      test("redirects when date is missing", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6022",
          name: "Override Empty",
        });
        await updateBuiltSiteRenewalState(site.id, {
          readOnlyFrom: "2027-01-01T00:00:00Z",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/override-deadline`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Choose a deadline date",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.readOnlyFrom).toBe("2027-01-01T00:00:00Z");
      });

      test("rejects an invalid date without pushing", () =>
        expectOverrideRejected("6023", "Override Invalid", "2027-02-31"));

      test("rejects a non-date-format string without pushing", () =>
        expectOverrideRejected("6024", "Override Not Date", "hello"));
    });

    describe("POST /admin/built-sites/:id/provision-renewal", () => {
      test("a failed push renders a retryable state and the retry provisions", async () => {
        // The provision route refuses without a qualifying renewal tier.
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 500,
        });
        const site = await createTestBuiltSite({
          hostingId: "6031",
          name: "Retry Site",
        });

        // The first provisioning's push fails: the token stands reserved,
        // unconfirmed, with the buyer's term stamped and no cutoff stored.
        await suite.withFailingSecretStub(async () => {
          const { response } = await siteAction(site, "provision-renewal", {
            months: "3",
          });
          expect(response.status).toBe(302);
        });
        const reserved = await findSite(site.id);
        expect(reserved.renewalTokenIndex).not.toBeNull();
        expect(reserved.renewalUrlConfirmed).toBe(false);
        expect(reserved.pendingRenewalCutoff).not.toBe("");

        // The page renders the pending state: the provision form is the only
        // control — no rotate, no deadline edits, no unconfirmed URL.
        suite.resetSecretStub();
        const panel = String(renewalPanelFor(await findSite(site.id)));
        expect(panel).toContain('/provision-renewal"');
        expect(panel).not.toContain('/rotate-renewal-token"');
        expect(panel).not.toContain('/bump-deadline"');
        expect(panel).not.toContain('/override-deadline"');
        expect(panel).not.toContain("Rotate token");

        // A direct deadline bump cannot confirm a cutoff over the retry.
        await siteAction(site, "bump-deadline", { months: "6" });
        const afterBump = await findSite(site.id);
        expect(afterBump.readOnlyFrom).toBe("");
        expect(afterBump.renewalUrlConfirmed).toBe(false);

        // The provision retry re-pushes the RESERVED token and the STAMPED
        // term — the form's own months cannot shrink what was reserved.
        await siteAction(site, "provision-renewal", { months: "1" });
        const provisioned = await findSite(site.id);
        expect(provisioned.renewalToken).toBe(reserved.renewalToken);
        expect(provisioned.renewalUrlConfirmed).toBe(true);
        expect(provisioned.readOnlyFrom.slice(0, 10)).toBe(
          reserved.pendingRenewalCutoff.slice(0, 10),
        );
      });
    });
  },
);
