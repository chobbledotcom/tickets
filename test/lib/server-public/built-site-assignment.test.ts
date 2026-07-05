// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import {
  createTestListing,
  describeWithEnv,
  expectReservedRedirectWithTokens,
  setTestEnv,
  submitTicketForm,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > built site assignment",
  { db: true, triggers: true },
  () => {
    describe("built site assignment", () => {
      test("registration succeeds when no sites available — auto-build is attempted in the background", async () => {
        const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
        const buildStub = stub(builderApi, "buildSite", () =>
          Promise.resolve({ error: "stubbed", ok: false as const }),
        );
        try {
          await createTestListing({
            hidden: true,
            monthsPerUnit: 1,
            name: "Monthly renewal tier",
            purchaseOnly: true,
          });
          const listing = await createTestListing({
            assignBuiltSite: true,
            maxAttendees: 10,
            thankYouUrl: "",
          });
          const response = await submitTicketForm(listing.slug, {
            email: "test@example.com",
            name: "Test User",
          });
          expectReservedRedirectWithTokens(response);
          expect(buildStub.calls.length).toBe(1);
        } finally {
          buildStub.restore();
          restore();
        }
      });

      test("registration succeeds when assignable sites are available", async () => {
        const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
        try {
          await createTestListing({
            hidden: true,
            monthsPerUnit: 1,
            name: "Monthly renewal tier",
            purchaseOnly: true,
          });
          const listing = await createTestListing({
            assignBuiltSite: true,
            maxAttendees: 10,
            thankYouUrl: "",
          });
          await insertBuiltSite(
            "Available",
            "avail.b-cdn.net",
            "",
            "",
            true,
          );
          const response = await submitTicketForm(listing.slug, {
            email: "test@example.com",
            name: "Test User",
          });
          expectReservedRedirectWithTokens(response);
        } finally {
          restore();
        }
      });
    });
  },
);
