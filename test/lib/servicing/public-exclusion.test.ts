/**
 * Servicing §16 — public-facing exclusion (defence in depth).
 *
 * A service event is a capacity hold on an existing listing, never a listing
 * itself, so none of the public surfaces can show it by nature. We assert it
 * anyway as a regression guard — "naturally true" rots. The only visible
 * public effect of a hold is reduced availability. The row is also hidden by
 * construction (kind='servicing' owns that state; the form cannot toggle it).
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { settings } from "#shared/db/settings.ts";
import {
  awaitTestRequest,
  createDailyTestListing,
  createServicingHold,
  createTestListing,
  describeWithEnv,
  extractCsrfToken,
  kindOf,
  mockFormRequest,
  mockRequest,
  setupStripe,
} from "#test-utils";

// jscpd:ignore-end

const HOLD_NAME = "Boiler Service";

const enablePublicSite = async (): Promise<void> => {
  await settings.update.showPublicSite(true);
};

const enablePublicApi = async (): Promise<void> => {
  await settings.update.showPublicApi(true);
};

/** Create a daily listing + a servicing hold on 2026-07-01, returning the
 *  listing. The shape every "public surface excludes the hold" test needs. */
const createDailyHold = async (
  listingOverrides: Parameters<typeof createDailyTestListing>[0] = {},
) => {
  await enablePublicSite();
  const listing = await createDailyTestListing({
    maxAttendees: 5,
    name: "Room A",
    ...listingOverrides,
  });
  await createServicingHold({
    date: "2026-07-01",
    listing: { name: "Room A", ...listingOverrides },
    name: HOLD_NAME,
    quantity: 3,
  });
  return listing;
};

const calculate = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const page = await handleRequest(mockRequest(`/ticket/${slug}`));
  const csrf = extractCsrfToken(await page.text()) ?? "";
  return handleRequest(
    mockFormRequest(`/calculate/${slug}`, { csrf_token: csrf, ...data }),
  );
};

/** Fetch a public path's body and assert it neither contains the hold name
 *  nor any `"kind"` field (servicing rows aren't listings). */
const assertPublicBodyExcludesHold = async (
  path: string,
  listingName: string,
): Promise<void> => {
  const body = await (await awaitTestRequest(path)).text();
  expect(body).toContain(listingName);
  expect(body).not.toContain(HOLD_NAME);
};

describeWithEnv("servicing §16 — public-facing exclusion", { db: true }, () => {
  test("/listings shows reduced availability but never the service event", async () => {
    await createDailyHold();
    await assertPublicBodyExcludesHold("/listings", "Room A");
  });

  test("the public homepage does not render the service event", async () => {
    await createDailyHold();
    const body = await (await awaitTestRequest("/")).text();
    expect(body).not.toContain(HOLD_NAME);
  });

  test("the public /calculate quote prices listings only — a service event can't be added or shown", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      maxQuantity: 5,
      name: "Room A",
      unitPrice: 1000,
    });
    await createServicingHold({
      listing: { name: "Room A" },
      name: HOLD_NAME,
      quantity: 3,
    });
    const body = await (
      await calculate(listing.slug, { [`quantity_${listing.id}`]: "1" })
    ).text();
    expect(body).toContain("Room A");
    expect(body).not.toContain(HOLD_NAME);
  });

  test("GET /api/listings returns active listings only — no servicing rows", async () => {
    await enablePublicApi();
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Room A",
    });
    await createServicingHold({
      listing: { name: "Room A" },
      name: HOLD_NAME,
    });
    const body = await (await awaitTestRequest("/api/listings")).text();
    expect(body).toContain("Room A");
    expect(body).not.toContain(HOLD_NAME);
    // The API returns listing objects (no `kind` field at all); a servicing
    // row can't appear because it isn't a listing.
    expect(body).not.toContain('"kind"');
  });

  test("a service event is hidden from the public site by construction", async () => {
    const { id } = await createServicingHold();
    // The servicing row carries the locked hidden-from-public state: kind owns
    // it, and there is no `hidden` column on attendees to toggle — a servicing
    // row is hidden because it is never a public listing.
    expect(await kindOf(id)).toBe(SERVICING_KIND);
  });
});
