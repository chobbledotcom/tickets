/**
 * What a booking's background follow-up arms do when they die: the incident
 * must reach the operator, because the buyer has already paid and the booking
 * stands.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  builtSites,
  insertBuiltSite,
  updateBuiltSiteRenewalState,
} from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { ErrorCode } from "#shared/logger.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";

const loggedIncident = (
  errorSpy: { calls: { args: unknown[] }[] },
  detail: string,
): boolean =>
  errorSpy.calls.some(
    ({ args }) =>
      String(args[0]).includes(ErrorCode.SITE_ASSIGNMENT) &&
      String(args[0]).includes(detail),
  );

describeWithEnv("registration follow-up failures", { db: true }, () => {
  test("reports an assignment arm that throws after a booking", async () => {
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    // The hidden monthly tier the assignment's validation gate requires.
    await createTestListing({
      hidden: true,
      monthsPerUnit: 1,
      purchaseOnly: true,
    });
    // The claim succeeds, then the initial renewal push rejects — the arm
    // dies holding the buyer's site, and the booking is already paid for.
    await insertBuiltSite("Pooled", "pooled.test", "", "", true, "88");
    const errorSpy = stub(console, "error", () => {});
    using _push = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.reject(new Error("provider rejected the initial push")),
    );
    try {
      await runWithPendingWork(() =>
        logAndNotifyRegistration([
          makeEntry({
            assign_built_site: true,
            initial_site_months: 1,
          }),
        ]),
      );
    } finally {
      errorSpy.restore();
    }

    expect(
      loggedIncident(
        errorSpy,
        "Site assignment failed after a completed booking",
      ),
    ).toBe(true);
  });

  test("reports a renewal arm that throws after a booking", async () => {
    await insertBuiltSite("Renewable", "renew.test", "", "", false, "77");
    const site = (await builtSites.getAll()).find(
      ({ name }) => name === "Renewable",
    )!;
    await updateBuiltSiteRenewalState(site.id, {
      renewalToken: "stored-token",
      renewalTokenIndex: "stored-index",
    });
    const errorSpy = stub(console, "error", () => {});
    using _push = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
      Promise.reject(new Error("provider rejected the push")),
    );

    try {
      await runWithPendingWork(() =>
        logAndNotifyRegistration(
          [
            makeEntry({
              hidden: true,
              months_per_unit: 1,
              purchase_only: true,
            }),
          ],
          "stored-index",
        ),
      );
    } finally {
      errorSpy.restore();
    }

    expect(
      loggedIncident(
        errorSpy,
        "Renewal was not applied after a completed booking",
      ),
    ).toBe(true);
  });
});
