/**
 * The Actions tab of a listing: which actions each role is offered, and which
 * of them sit in the danger zone.
 *
 * Every entry repeats the gate its target route enforces, so an action that
 * renders is always one the viewer can carry out.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";

const DANGER_ZONE = 'class="entity-danger-zone"';

/** The Actions tab as two halves: the ordinary actions and the danger zone. */
const actionsOf = async (
  listingId: number,
  cookie?: string,
): Promise<{ plain: string; danger: string }> => {
  const path = `/admin/listing/${listingId}/actions`;
  const response = cookie
    ? await awaitTestRequest(path, { cookie })
    : await adminGet(path);
  const html = await response.text();
  const split = html.indexOf(DANGER_ZONE);
  return split === -1
    ? { danger: "", plain: html }
    : { danger: html.slice(split), plain: html.slice(0, split) };
};

const hrefFor = (listingId: number, action: string): string =>
  `href="/admin/listing/${listingId}/${action}"`;

describeWithEnv("the actions on a paid listing", { db: true }, () => {
  const paidListing = () =>
    createTestListing({ maxAttendees: 100, name: "Paid", unitPrice: 1000 });

  test("offers the owner a refund-all, in the danger zone", async () => {
    const listing = await paidListing();

    const { danger, plain } = await actionsOf(listing.id);

    expect(danger).toContain(hrefFor(listing.id, "refund-all"));
    expect(danger).toContain("Refund All");
    expect(plain).not.toContain(hrefFor(listing.id, "refund-all"));
  });

  test("keeps refund-all from a manager, who may not move money", async () => {
    const listing = await paidListing();
    const cookie = await createTestManagerSession();

    const { danger, plain } = await actionsOf(listing.id, cookie);

    expect(danger + plain).not.toContain(hrefFor(listing.id, "refund-all"));
  });

  test("keeps refund-all off a listing that takes no money", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Free",
    });

    const { danger, plain } = await actionsOf(listing.id);

    expect(danger + plain).not.toContain(hrefFor(listing.id, "refund-all"));
  });
});

describeWithEnv("the email action", { db: true }, () => {
  const listingWithSomeoneToEmail = async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Has Attendees",
    });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Reachable",
      "reachable@example.com",
    );
    return listing;
  };

  test("is offered to the owner when there is someone to email", async () => {
    const listing = await listingWithSomeoneToEmail();

    const { plain } = await actionsOf(listing.id);

    expect(plain).toContain(`href="/admin/emails?`);
    expect(plain).toContain("Email");
  });

  test("is not offered when the listing has nobody on it", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Empty",
    });

    const { danger, plain } = await actionsOf(listing.id);

    expect(danger + plain).not.toContain(`href="/admin/emails?`);
  });

  test("is not offered to a manager, even with someone to email", async () => {
    const listing = await listingWithSomeoneToEmail();
    const cookie = await createTestManagerSession();

    const { danger, plain } = await actionsOf(listing.id, cookie);

    expect(danger + plain).not.toContain(`href="/admin/emails?`);
  });
});

describeWithEnv("the actions that end a listing", { db: true }, () => {
  test("puts deactivate and delete in the danger zone", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Endable",
    });

    const { danger, plain } = await actionsOf(listing.id);

    expect(danger).toContain(hrefFor(listing.id, "deactivate"));
    expect(danger).toContain(hrefFor(listing.id, "delete"));
    expect(plain).not.toContain(hrefFor(listing.id, "deactivate"));
    expect(plain).not.toContain(hrefFor(listing.id, "delete"));
  });

  test("leaves reactivate out of it, because bringing one back is safe", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Dormant",
    });
    await adminFormPost(`/admin/listing/${listing.id}/deactivate`, {
      confirm_identifier: listing.name,
    });

    const { danger, plain } = await actionsOf(listing.id);

    expect(plain).toContain(hrefFor(listing.id, "reactivate"));
    expect(danger).not.toContain(hrefFor(listing.id, "reactivate"));
  });
});
