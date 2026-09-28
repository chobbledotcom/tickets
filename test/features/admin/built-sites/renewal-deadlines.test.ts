import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSites } from "#db/built-sites.ts";
import { handleRequest } from "#routes";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestBuiltSite,
  provisionTestBuiltSite,
} from "#test-utils/db-helpers/built-sites.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { renewalSuiteHelpers, reSyncDeadlineSecrets } from "./renewal-setup.ts";

const findSite = async (siteId: number): Promise<BuiltSite> =>
  (await builtSites.getAll()).find((s) => s.id === siteId)!;

describeWithEnv(
  "admin built-sites renewal deadlines",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = renewalSuiteHelpers();

    describe("POST /admin/built-sites/:id/re-sync-deadline", () => {
      test("re-pushes stored deadline and RENEWAL_URL when provisioned", async () => {
        const secretNames = await reSyncDeadlineSecrets(
          suite,
          "6030",
          "Resync Site",
          "2027-03-15T00:00:00Z",
          true,
        );

        expect(secretNames).toContain("READ_ONLY_FROM");
        expect(secretNames).toContain("RENEWAL_URL");
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain("Admin re-synced deadline for 'Resync Site'");
      });

      test("re-pushes deadline without RENEWAL_URL when unprovisioned", async () => {
        const secretNames = await reSyncDeadlineSecrets(
          suite,
          "6031",
          "Resync Unprovisioned",
          "2027-04-01T00:00:00Z",
          false,
        );

        expect(secretNames).toContain("READ_ONLY_FROM");
        expect(secretNames).not.toContain("RENEWAL_URL");
      });

      test("redirects when deadline is empty", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6032",
          name: "Resync Empty",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/re-sync-deadline`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "No deadline to re-sync",
          false,
        )(response);

        expect(suite.secretStub.calls.length).toBe(0);
      });
    });

    describe("POST /admin/built-sites/:id/provision-renewal", () => {
      test("provisions an unprovisioned site with token and deadline (no tier id stored)", async () => {
        // A qualifying tier must exist so the customer has something to pick at /renew.
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 500,
        });
        const site = await createTestBuiltSite({
          hostingId: "6040",
          name: "Provision Site",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/provision-renewal`,
          { months: "3" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal provisioned",
        )(response);

        const updated = await findSite(site.id);
        expect(updated.renewalTokenIndex).not.toBeNull();
        expect(updated.renewalToken).not.toBeNull();
        expect(updated.readOnlyFrom).not.toBe("");

        const renewResponse = await handleRequest(
          mockRequest(`/renew/?t=${encodeURIComponent(updated.renewalToken!)}`),
        );
        expect(renewResponse.status).toBe(200);
        expect(
          (await getAllActivityLog()).map(({ message }) => message),
        ).toContain("Admin provisioned renewals for 'Provision Site' (3mo)");
      });

      test("rejects when no qualifying tier listing exists", async () => {
        const site = await createTestBuiltSite({
          hostingId: "6041",
          name: "No Tier Provision",
        });

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/provision-renewal`,
          { months: "3" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Create a qualifying renewal tier listing before provisioning",
          false,
        )(response);

        const updated = await findSite(site.id);
        expect(updated.renewalTokenIndex).toBeNull();
      });

      test("redirects on already provisioned site", async () => {
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 500,
        });
        const site = await createTestBuiltSite({
          hostingId: "6042",
          name: "Already Provisioned",
        });
        await provisionTestBuiltSite(site.id);

        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/provision-renewal`,
          { months: "3" },
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/renewal`,
          "Renewal is already provisioned for this site",
          false,
        )(response);
      });

      test("Bunny failure leaves renewal state unprovisioned", async () => {
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          purchaseOnly: true,
          unitPrice: 500,
        });
        const site = await createTestBuiltSite({
          hostingId: "6043",
          name: "Provision Fail",
        });

        await suite.withFailingSecretStub(async () => {
          const { response } = await adminFormPost(
            `/admin/built-sites/${site.id}/provision-renewal`,
            { months: "3" },
          );
          await expectFlashRedirect(
            `/admin/built-sites/${site.id}/renewal`,
            "Renewal could not be pushed to the site",
            false,
          )(response);

          const updated = await findSite(site.id);
          expect(updated.renewalTokenIndex).not.toBeNull();
          expect(updated.readOnlyFrom).toBe("");
        });
      });
    });
  },
);
