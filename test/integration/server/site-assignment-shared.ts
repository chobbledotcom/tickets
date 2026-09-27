/** The pieces every site-assignment suite shares: the plan-listing entry and
 * the renewal-tier teardown both the assignment and config tests need. */

import { expect } from "@std/expect";
import { afterEach, beforeEach } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { builtSites } from "#db/built-sites.ts";
import { getAllListings } from "#db/listings/records.ts";
import { builderApi } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { hostEmail } from "#shared/email.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { validEmail } from "#test-utils/email.ts";
import { makeTestEntry } from "#test-utils/factories.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

/** Deactivate every active, hidden, purchase-only, monthly listing — the
 *  "renewal tier" set — so tests can exercise the no-qualifying-tier path. */
export const deactivateAllTierListings = async (): Promise<void> => {
  const listings = await getAllListings();
  for (const ev of listings) {
    if (ev.months_per_unit > 0 && ev.purchase_only && ev.hidden && ev.active) {
      await deactivateTestListing(ev.id);
    }
  }
};

/** Build an entry with assign_built_site for testing */
export const siteEntry = (
  overrides: {
    listingId?: number;
    listingName?: string;
    assignBuiltSite?: boolean;
    initialSiteMonths?: number;
    attendeeId?: number;
    quantity?: number;
    email?: string;
    refunded?: boolean;
  } = {},
) =>
  makeTestEntry(
    {
      assign_built_site: overrides.assignBuiltSite ?? true,
      initial_site_months: overrides.initialSiteMonths ?? 3,
      ...(overrides.listingId !== undefined && { id: overrides.listingId }),
      ...(overrides.listingName !== undefined && {
        name: overrides.listingName,
      }),
    },
    {
      ...(overrides.attendeeId !== undefined && { id: overrides.attendeeId }),
      ...(overrides.email !== undefined && { email: overrides.email }),
      ...(overrides.quantity !== undefined && {
        quantity: overrides.quantity,
      }),
      ...(overrides.refunded !== undefined && {
        refunded: overrides.refunded,
      }),
    },
  );

/** Any assignment that builds a site has broken the pool-only contract. */
export const forbidBuildDuringAssignment = (): Stub =>
  stub(builderApi, "buildSite", () => {
    throw new Error("Assignment must hand out pre-built sites, never build");
  });

export const stubEdgeSecretSuccess = (): Stub =>
  stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
    Promise.resolve({ ok: true as const }),
  );

/** Keeps a deliberate error out of the test output, so the caller can
 *  read what was logged without printing it. */
export const silencedErrors = (): Stub => stub(console, "error", () => {});

/** The beforeEach/afterEach pair plus the email and flag-push assertions
 * every site-assignment suite runs on. Call once inside the suite body. */
export const setUpAssignmentSuite = () => {
  let fetchStub: Stub;
  let secretStub: Stub;

  beforeEach(async () => {
    fetchStub = stubFetch(() => new Response());
    secretStub = stubEdgeSecretSuccess();
    hostEmail.setOverride({
      apiKey: "re_test",
      fromAddress: validEmail("test@example.com"),
      provider: "resend",
    });
    await createTestListing({
      hidden: true,
      maxAttendees: 1000,
      monthsPerUnit: 1,
      purchaseOnly: true,
      unitPrice: 500,
    });
  });

  afterEach(() => {
    fetchStub.restore();
    if (!secretStub.restored) secretStub.restore();
    hostEmail.resetOverride();
  });

  const expectFlagPushOutcome = async (
    site: string,
    expected: string,
  ): Promise<import("#db/built-sites/types.ts").BuiltSite> => {
    const all = await builtSites.getAll();
    const found = all.find((s) => s.name === site)!;
    expect(found.renewalTokenIndex).not.toBeNull();
    expect(found.readOnlyFrom).toBeTruthy();
    expect(found.readOnlyFrom.slice(0, 10)).toBe(expected);
    return found;
  };

  const expectLastEmailBody = (expected: Record<string, unknown>) => {
    expect(fetchStub.calls.length).toBe(1);
    const body = JSON.parse(fetchStub.calls[0]!.args[1].body) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(expected)) {
      expect(body[key]).toBe(value);
    }
    return body;
  };

  return {
    expectFlagPushOutcome,
    expectLastEmailBody,
    /** The stubbed resend fetch, so tests can read the calls it captured. */
    get fetchStub(): Stub {
      return fetchStub;
    },
    get secretStub(): Stub {
      return secretStub;
    },
  };
};
