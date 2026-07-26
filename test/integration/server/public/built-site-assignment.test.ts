// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { builderApi } from "#shared/builder.ts";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import { expectReservedRedirectWithTokens } from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > built site assignment",
  { db: true, triggers: true },
  () => {
    describe("built site assignment", () => {
      /** A hidden monthly-renewal package tier alongside the
       * `assignBuiltSite` listing under test — the shared fixture behind
       * both scenarios below. */
      const createAssignBuiltSiteListing = async () => {
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          name: "Monthly renewal tier",
          purchaseOnly: true,
        });
        return createTestListing({
          assignBuiltSite: true,
          maxAttendees: 10,
          thankYouUrl: "",
        });
      };

      /** Books the `assignBuiltSite` listing as a plain free registration —
       * the shared submission behind both scenarios below. */
      const bookAssignBuiltSiteListing = (listing: {
        slug: string;
      }): Promise<Response> =>
        submitTicketForm(listing.slug, {
          email: "test@example.com",
          name: "Test User",
        });

      test("registration succeeds when no sites available — auto-build is attempted in the background", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        const buildStub = stub(builderApi, "buildSite", () =>
          Promise.resolve({ error: "stubbed", ok: false as const }),
        );
        try {
          const listing = await createAssignBuiltSiteListing();
          const response = await bookAssignBuiltSiteListing(listing);
          expectReservedRedirectWithTokens(response);
          expect(buildStub.calls.length).toBe(1);
        } finally {
          buildStub.restore();
        }
      });

      test("registration succeeds when assignable sites are available", async () => {
        using _env = withEnv({ CAN_BUILD_SITES: "true" });
        const listing = await createAssignBuiltSiteListing();
        await insertBuiltSite("Available", "avail.b-cdn.net", "", "", true);
        const response = await bookAssignBuiltSiteListing(listing);
        expectReservedRedirectWithTokens(response);
      });
    });
  },
);
