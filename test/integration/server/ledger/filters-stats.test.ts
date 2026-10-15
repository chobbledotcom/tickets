import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#accounting/kinds.ts";
import { MANUAL_LISTING_COST } from "#accounting/manual-entries.ts";
import { postTransferGroups } from "#accounting/store.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { account } from "#shared/ledger/account.ts";
import {
  listingMoneyLegs,
  seededSale,
} from "#test/integration/server/ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { tx } from "#test-utils/ledger.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("server (admin ledger filters and stats)", { db: true }, () => {
  test("shows the headline stats, both date pickers and the listing filter", async () => {
    await seededSale("Summer Concert", 2500);
    const response = await adminGet("/admin/ledger?view=dual");
    const html = await response.text();
    // The by-listing filter offers the whole-business "All listings" scope, and
    // the four business-wide totals render beneath it (no scope heading — the
    // page is already titled "Money").
    assertStringIncludes(html, "Everything");
    assert(
      !html.includes("<h2>Everything</h2>"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "Total income earned");
    assertStringIncludes(html, "Customer balances due");
    assertStringIncludes(html, "Total refunded");
    assertStringIncludes(html, "Booking fees");
    // Two range pickers with unique anchor ids, plus the by-listing select.
    assertStringIncludes(html, 'id="ledger-from"');
    assertStringIncludes(html, 'id="ledger-to"');
    assertStringIncludes(html, "Summer Concert");
  });

  test("a from-date later than the only transfer empties the list and zeroes income", async () => {
    // The seeded sale occurs on 2026-06-21; filtering from the 22nd excludes it.
    await seededSale("Workshop", 2500);
    const response = await adminGet("/admin/ledger?from=2026-06-22");
    const html = await response.text();
    assertStringIncludes(html, "No money changes yet.");
    // Income stat falls to zero outside the window.
    assertStringIncludes(html, "Total income");
  });

  test("scoping to a listing shows its revenue breakdown and preselects it", async () => {
    const { listingId } = await seededSale("Pottery", 2500);
    const response = await adminGet(`/admin/ledger?listing=${listingId}`);
    const html = await response.text();
    // The stats switch to the per-listing breakdown, headed by the listing name.
    assertStringIncludes(html, "Gross ticket sales");
    assertStringIncludes(html, "Total income earned");
    assertStringIncludes(html, "Net after refunds and costs");
    // The by-listing select is preselected to this listing.
    assertStringIncludes(
      html,
      `<option selected value="/admin/ledger?listing=${listingId}">`,
    );
  });

  test("listing stats keep servicing costs inside the selected dates", async () => {
    const listing = await createTestListing({ name: "Dated listing" });
    await postTransferGroups(
      [
        ...listingMoneyLegs({
          cost: 1000,
          income: 2500,
          listingId: listing.id,
          occurredAt: "2026-06-15T12:00:00.000Z",
          prefix: "listing-june",
        }),
        ...listingMoneyLegs({
          cost: 2000,
          income: 4000,
          listingId: listing.id,
          occurredAt: "2026-07-15T12:00:00.000Z",
          prefix: "listing-july",
        }),
      ].map((leg) => [leg]),
    );
    const response = await adminGet(
      `/admin/ledger?listing=${listing.id}&from=2026-06-01&to=2026-06-30`,
    );
    const html = await response.text();
    assertStringIncludes(html, "+£25");
    assertStringIncludes(html, "−£10");
    assertStringIncludes(html, "£15");
    assert(
      !html.includes("−£30"),
      "the value should not contain the searched item",
    );
  });

  test("scoping to a group combines its current listings", async () => {
    const group = await createTestGroup({ name: "Festival package" });
    const first = await seededSale("Morning show", 2500);
    const second = await seededSale("Evening show", 3500);
    await assignListingsToGroup([first.listingId, second.listingId], group.id);
    await seededSale("Outside group", 1000);
    const response = await adminGet(`/admin/ledger?group=${group.id}`);
    const html = await response.text();
    assertStringIncludes(html, "<h2>Festival package</h2>");
    assertStringIncludes(html, "Total income earned");
    assertStringIncludes(html, "+£60");
    assert(
      !html.includes("+£70"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      `<option selected value="/admin/ledger?group=${group.id}">Festival package</option>`,
    );
  });

  test("group stats keep the full money breakdown inside the selected dates", async () => {
    const group = await createTestGroup({ name: "Dated package" });
    const first = await createTestListing({ name: "June main" });
    const second = await createTestListing({ name: "June extra" });
    await assignListingsToGroup([first.id, second.id], group.id);
    await postTransferGroups(
      [
        ...listingMoneyLegs({
          cost: 1000,
          income: 2500,
          listingId: first.id,
          occurredAt: "2026-06-15T12:00:00.000Z",
          prefix: "group-first-june",
        }),
        ...listingMoneyLegs({
          cost: 200,
          income: 500,
          listingId: second.id,
          occurredAt: "2026-06-20T12:00:00.000Z",
          prefix: "group-second-june",
        }),
        tx({
          amount: 700,
          destination: account("attendee", 1),
          eventGroup: "group-june-refund",
          kind: KIND.refundSale,
          occurredAt: "2026-06-21T12:00:00.000Z",
          reference: "group-june-refund",
          source: account("revenue", first.id),
        }),
        tx({
          amount: 300,
          destination: account("external", "world"),
          eventGroup: "group-june-external-cost",
          kind: MANUAL_LISTING_COST,
          occurredAt: "2026-06-22T12:00:00.000Z",
          reference: "group-june-external-cost",
          source: account("revenue", second.id),
        }),
        ...listingMoneyLegs({
          cost: 2000,
          income: 4000,
          listingId: first.id,
          occurredAt: "2026-07-15T12:00:00.000Z",
          prefix: "group-first-july",
        }),
      ].map((leg) => [leg]),
    );
    const response = await adminGet(
      `/admin/ledger?group=${group.id}&from=2026-06-01&to=2026-06-30`,
    );
    const html = await response.text();
    assertStringIncludes(html, "Gross ticket sales");
    assertStringIncludes(html, "+£30");
    assertStringIncludes(html, "−£12");
    assertStringIncludes(html, "Total refunded");
    assertStringIncludes(html, "−£7");
    assertStringIncludes(html, "Costs paid outside checkout");
    assertStringIncludes(html, "−£3");
    assertStringIncludes(html, "Net after refunds and costs");
    assertStringIncludes(html, "£8");
    assert(
      !html.includes("£11"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("£18"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("+£70"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("−£32"),
      "the value should not contain the searched item",
    );
  });

  test("an empty group scope never falls back to the whole ledger", async () => {
    await seededSale("Unrelated show", 2500);
    const group = await createTestGroup({ name: "Empty group" });
    const response = await adminGet(`/admin/ledger?group=${group.id}`);
    const html = await response.text();
    assertStringIncludes(html, "<h2>Empty group</h2>");
    assertStringIncludes(html, "No money changes yet.");
  });

  test("lists every listing in the by-listing select, name-sorted", async () => {
    // Two listings exercise the sort comparator and prove both appear as options.
    await seededSale("Zither Workshop", 2500);
    await seededSale("Accordion Night", 2500);
    await createTestGroup({ name: "Winter package" });
    await createTestGroup({ name: "Autumn package" });
    const response = await adminGet("/admin/ledger");
    const html = await response.text();
    assertStringIncludes(html, "Zither Workshop");
    assertStringIncludes(html, "Accordion Night");
    // Sorted A→Z, so Accordion's option precedes Zither's.
    expect(html.indexOf("Accordion Night")).toBeLessThan(
      html.indexOf("Zither Workshop"),
    );
    expect(html.indexOf("Autumn package")).toBeLessThan(
      html.indexOf("Winter package"),
    );
  });

  test("an unknown listing id falls back to the all-listings view", async () => {
    await seededSale("Recital", 2500);
    const response = await adminGet("/admin/ledger?listing=999999");
    expect(response.status).toBe(200);
    const html = await response.text();
    // Falls back to the business-wide totals rather than a listing breakdown.
    assertStringIncludes(html, "Total income");
    assert(
      !html.includes("Gross ticket sales"),
      "the value should not contain the searched item",
    );
  });

  test("a valid listing takes precedence over a valid group", async () => {
    const listing = await seededSale("Priority recital", 2500);
    const grouped = await seededSale("Grouped recital", 3500);
    const group = await createTestGroup({ name: "Recital package" });
    await assignListingsToGroup([grouped.listingId], group.id);

    const response = await adminGet(
      `/admin/ledger?listing=${listing.listingId}&group=${group.id}`,
    );
    const html = await response.text();

    assertStringIncludes(html, "<h2>Priority recital</h2>");
    assertStringIncludes(html, "+£25");
    assert(
      !html.includes("+£35"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      `<option selected value="/admin/ledger?listing=${listing.listingId}">Priority recital</option>`,
    );
  });

  test("a valid group is used when the listing is unknown", async () => {
    const grouped = await seededSale("Fallback recital", 3500);
    const group = await createTestGroup({ name: "Fallback package" });
    await assignListingsToGroup([grouped.listingId], group.id);

    const response = await adminGet(
      `/admin/ledger?listing=999999&group=${group.id}`,
    );
    const html = await response.text();

    assertStringIncludes(html, "<h2>Fallback package</h2>");
    assertStringIncludes(html, "+£35");
    assertStringIncludes(
      html,
      `<option selected value="/admin/ledger?group=${group.id}">Fallback package</option>`,
    );
  });

  test("an unknown positive group id falls back to the whole ledger", async () => {
    await seededSale("Whole ledger recital", 2500);

    const response = await adminGet("/admin/ledger?group=999999");
    const html = await response.text();

    expect(response.status).toBe(200);
    assertStringIncludes(html, "Total income earned");
    assertStringIncludes(html, "+£25");
    assert(
      !html.includes("Gross ticket sales"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      '<option selected value="/admin/ledger">Everything</option>',
    );
  });

  test("ignores malformed from/to/listing/month params", async () => {
    await seededSale("Matinee", 2500);
    const response = await adminGet(
      "/admin/ledger?from=garbage&to=alsobad&listing=abc&fromCal=nope",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // Every bad param is dropped, so the unfiltered all-listings list still shows
    // the seeded sale in the default human view.
    assertStringIncludes(html, "Matinee");
    assertStringIncludes(html, "booked");
    assert(
      !html.includes("<td>sale</td>"),
      "the value should not contain the searched item",
    );
  });

  test("honours a valid to-date bound and a paged from-month", async () => {
    await seededSale("Concerto", 2500);
    const response = await adminGet(
      "/admin/ledger?to=2026-06-21&fromCal=2026-05",
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // The 2026-06-21 sale falls within "up to and including the 21st".
    assertStringIncludes(html, "Concerto");
    // The from picker is paged to May 2026, so its prev-month link targets April.
    assertStringIncludes(html, "fromCal=2026-04");
  });
});
