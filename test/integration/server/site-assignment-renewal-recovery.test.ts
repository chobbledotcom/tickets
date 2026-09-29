import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { builtSites, insertBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { nowIso } from "#shared/now.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
import { recordingRenewalUrlPush } from "#test-utils/builder-mocks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  failingRenewalUrlPush,
  setUpAssignmentSuite,
  siteEntry,
  stubEdgeSecretSuccess,
} from "./site-assignment-shared.ts";

describeWithEnv(
  "site-assignment renewal recovery",
  {
    db: true,
    env: { CAN_BUILD_SITES: "true" },
  },
  () => {
    const suite = setUpAssignmentSuite();

    const createTierListing = (unitPrice = 500, monthsPerUnit = 1) =>
      createTestListing({
        hidden: true,
        maxAttendees: 1000,
        monthsPerUnit,
        purchaseOnly: true,
        unitPrice,
      });

    /** Run one assignment with the RENEWAL_URL push failing, so the token
     * stands reserved but unconfirmed, and return the named site's state. */
    const runFailedFirstPush = async (
      firstRun: () => Promise<void>,
      siteName: string,
    ): Promise<import("#db/built-sites/types.ts").BuiltSite> => {
      suite.secretStub.restore();
      const failStub = failingRenewalUrlPush();
      await firstRun();
      const afterFirst = (await builtSites.getAll()).find(
        (s) => s.name === siteName,
      )!;
      expect(afterFirst.renewalTokenIndex).not.toBeNull();
      expect(afterFirst.readOnlyFrom).toBe("");
      failStub.restore();
      return afterFirst;
    };

    /** Run one assignment with the RENEWAL_URL push failing, assert the
     * claim stands with its token reserved but unconfirmed, then re-run with
     * pushes working and return the named site's state after each run. */
    const runFailedPushThenResend = async (
      firstRun: () => Promise<void>,
      resend: () => Promise<void>,
      siteName: string,
    ): Promise<{
      afterFirst: import("#db/built-sites/types.ts").BuiltSite;
      afterResend: import("#db/built-sites/types.ts").BuiltSite;
    }> => {
      const afterFirst = await runFailedFirstPush(firstRun, siteName);
      expect(afterFirst.assignedAttendeeId).not.toBeNull();
      const okStub = stubEdgeSecretSuccess();
      try {
        await resend();
        const afterResend = (await builtSites.getAll()).find(
          (s) => s.name === siteName,
        )!;
        // The resend confirms the reserved token; it never mints a new one.
        expect(afterResend.renewalToken).toBe(afterFirst.renewalToken);
        return { afterFirst, afterResend };
      } finally {
        okStub.restore();
      }
    };

    test("the failing push stub lets every other secret through", async () => {
      suite.secretStub.restore();
      using failStub = failingRenewalUrlPush();
      const result = await bunnyCdnApi.setEdgeScriptSecret(
        1,
        "READ_ONLY_FROM",
        "2099-01-01T00:00:00.000Z",
      );
      expect(result).toEqual({ ok: true });
      expect(failStub.calls.length).toBe(1);
    });

    describe("renewal at site assignment", () => {
      test("a reversed resend still completes an unprovisioned renewal", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");
        await insertBuiltSite("Site B", "b.test.net", "", "", true, "2002");

        // The resend lists the other listing first: the buyer reads as
        // served, and the claim lookup must span both listings.
        const { afterResend } = await runFailedPushThenResend(
          () =>
            assignAndNotifyBuiltSites([
              siteEntry({
                attendeeId: 10,
                listingId: 1,
                listingName: "Plan One",
              }),
              siteEntry({
                attendeeId: 10,
                listingId: 2,
                listingName: "Plan Two",
              }),
            ]),
          () =>
            assignAndNotifyBuiltSites([
              siteEntry({
                attendeeId: 10,
                listingId: 2,
                listingName: "Plan Two",
              }),
              siteEntry({
                attendeeId: 10,
                listingId: 1,
                listingName: "Plan One",
              }),
            ]),
          "Site A",
        );
        expect(afterResend.renewalTokenIndex).not.toBeNull();
        expect(afterResend.readOnlyFrom).not.toBe("");
      });

      test("a recovery finishes the provisioning with the term the plan states today", async () => {
        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");
        await createTierListing();

        const afterFirst = await runFailedFirstPush(
          () =>
            assignAndNotifyBuiltSites([
              siteEntry({
                attendeeId: 10,
                initialSiteMonths: 3,
                quantity: 3,
              }),
            ]),
          "Site A",
        );

        // The owner retunes the plan to 1 month, then the resend finishes
        // the unprovisioned renewal with the term the plan states today —
        // and it never mints a second token.
        const okStub = stubEdgeSecretSuccess();
        try {
          await assignAndNotifyBuiltSites([
            siteEntry({
              attendeeId: 10,
              initialSiteMonths: 1,
              quantity: 3,
            }),
          ]);
          const afterResend = (await builtSites.getAll()).find(
            (s) => s.name === "Site A",
          )!;
          expect(afterResend.renewalToken).toBe(afterFirst.renewalToken);
          expect(afterResend.readOnlyFrom.slice(0, 10)).toBe(
            addMonthsIso(nowIso(), 3).slice(0, 10),
          );
        } finally {
          okStub.restore();
        }
      });

      test("two concurrent recovery resends push one reserved token", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        // First run: the push fails, so the token stands reserved unconfirmed.
        await runFailedFirstPush(
          () => assignAndNotifyBuiltSites([siteEntry()]),
          "Site A",
        );

        // Two resends race to complete the renewal. Both must push the
        // reserved token — the database and the provider cannot end up on
        // different tokens.
        const recorder = recordingRenewalUrlPush();
        try {
          await Promise.all([
            assignAndNotifyBuiltSites([siteEntry()]),
            assignAndNotifyBuiltSites([siteEntry()]),
          ]);

          const afterRace = (await builtSites.getAll()).find(
            (s) => s.name === "Site A",
          )!;
          expect(afterRace.readOnlyFrom).not.toBe("");
          expect(recorder.pushedUrls.length).toBeGreaterThanOrEqual(1);
          for (const pushed of recorder.pushedUrls) {
            expect(pushed).toContain(afterRace.renewalToken!);
          }
        } finally {
          recorder.stub.restore();
        }
      });

      test("a resend completes a renewal the first push failed to provision", async () => {
        await createTierListing();

        await insertBuiltSite("Site A", "a.test.net", "", "", true, "2001");

        const { afterFirst, afterResend } = await runFailedPushThenResend(
          () => assignAndNotifyBuiltSites([siteEntry()]),
          () => assignAndNotifyBuiltSites([siteEntry()]),
          "Site A",
        );
        expect(afterResend.assignedAttendeeId).toBe(
          afterFirst.assignedAttendeeId,
        );
        expect(afterResend.renewalTokenIndex).not.toBeNull();
        expect(afterResend.readOnlyFrom).not.toBe("");
      });
    });
  },
);
