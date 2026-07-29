import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { cancelPageResponse } from "#routes/api/payment-processing/cancel.ts";
import { getDb } from "#shared/db/client.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem, webhookMeta } from "#test-utils/factories.ts";
import { makeParent } from "#test-utils/parents.ts";

/** A cancelled checkout carrying the given lines. The buyer never paid, so the
 *  session has no payment to point at. */
const cancelledSession = (items: string): ValidatedPaymentSession => ({
  amountTotal: 0,
  id: "cs_cancelled",
  metadata: webhookMeta({
    email: "john@example.com",
    items,
    name: "John",
  }) satisfies SessionMetadata,
  paymentReference: null,
  paymentStatus: "unpaid",
});

/** One package line: a member bought as part of the bundle it hangs off. */
const packageLine = (listingId: number, groupId: number): string =>
  JSON.stringify([{ e: listingId, k: "p", p: 1000, q: 1, r: groupId }]);

/** Renders the cancel page and hands back the markup plus anything the page
 *  asked to be written to the log. */
const renderCancelPage = async (items: string) => {
  const logged: string[] = [];
  const response = await cancelPageResponse(cancelledSession(items), (detail) =>
    logged.push(detail),
  );
  return { html: await response.text(), logged, status: response.status };
};

describeWithEnv("the page a cancelled checkout lands on", { db: true }, () => {
  test("offers the listing's own page to try again", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const { html, status } = await renderCancelPage(
      singleItem(listing.id, 1, 1000),
    );

    expect(status).toBe(200);
    expect(html).toContain(`/ticket/${listing.slug}`);
  });

  test("offers the first listing's page when the order had several lines", async () => {
    const first = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const second = await createTestListing({
      maxAttendees: 50,
      unitPrice: 2000,
    });

    const { html } = await renderCancelPage(
      JSON.stringify([
        { e: first.id, p: 1000, q: 1 },
        { e: second.id, p: 4000, q: 2 },
      ]),
    );

    expect(html).toContain(`/ticket/${first.slug}`);
    expect(html).not.toContain(`/ticket/${second.slug}`);
  });

  test("offers the bundle's page when the order bought a package", async () => {
    // A member's own page may hide members or use different prices, so the
    // bundle's page is the one that re-offers what was being bought.
    const group = await createTestGroup({
      isPackage: true,
      name: "Cancel Pkg",
      slug: "cancel-pkg-direct",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const { html } = await renderCancelPage(packageLine(member.id, group.id));

    expect(html).toContain(`/ticket/${group.slug}`);
    expect(html).not.toContain(`/ticket/${member.slug}`);
  });

  test("offers the member's page when the bundle can no longer be bought", async () => {
    // A package is all or nothing, so turning off a second member leaves the
    // bundle incomplete and its page gone.
    const group = await createTestGroup({
      isPackage: true,
      name: "Dead Bundle",
      slug: "dead-bundle-direct",
    });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const turnedOff = await createTestListing({
      groupId: group.id,
      maxAttendees: 50,
      unitPrice: 1000,
    });
    await getDb().execute({
      args: [turnedOff.id],
      sql: "UPDATE listings SET active = 0 WHERE id = ?",
    });

    const { html } = await renderCancelPage(packageLine(member.id, group.id));

    expect(html).toContain(`/ticket/${member.slug}`);
    expect(html).not.toContain(`/ticket/${group.slug}`);
  });

  test("offers the member's page when the bundle has been deleted", async () => {
    const member = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    const { html } = await renderCancelPage(packageLine(member.id, 99999));

    expect(html).toContain(`/ticket/${member.slug}`);
  });

  test("offers nothing to try again when the listing lost its own page", async () => {
    // The child had its own page when the checkout began. It is a plain child
    // now, so that page is gone and a link to it would dead-end.
    const { child } = await makeParent({
      children: [{ maxAttendees: 50, unitPrice: 1000 }],
    });

    const { html, status } = await renderCancelPage(
      singleItem(child.id, 1, 1000),
    );

    expect(status).toBe(200);
    expect(html).not.toContain(`/ticket/${child.slug}`);
  });

  // Without a listing there is no page to show and nothing to try again, so
  // each of these ends the same way — and says so in the log, because a paid
  // buyer landing here is something the owner needs to see.
  for (const [name, items, listingId] of [
    ["the listing has been deleted", singleItem(99999, 1, 0), 99999],
    ["the order bought nothing", "[]", 0],
    ["what was bought cannot be read", "not-json", 0],
    ["a line names no listing", JSON.stringify([{ e: 0, p: 1, q: 1 }]), 0],
  ] as const) {
    test(`says the listing was not found when ${name}`, async () => {
      const { html, logged, status } = await renderCancelPage(items);

      expect(status).toBe(404);
      expect(html).toContain("Listing not found");
      expect(logged).toEqual([
        `Listing not found (session=cs_cancelled, listingId=${listingId})`,
      ]);
    });
  }
});
