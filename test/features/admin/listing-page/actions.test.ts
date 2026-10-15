/**
 * The Actions tab of a listing: which actions each role is offered, and which
 * of them sit in the danger zone.
 *
 * Every entry repeats the gate its target route enforces, so an action that
 * renders is always one the viewer can carry out.
 */

import { assert } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { says } from "#test-utils/says.ts";
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

    says(danger, hrefFor(listing.id, "refund-all"));
    says(danger, "Refund All");
    assert(!plain.includes(hrefFor(listing.id, "refund-all")));
  });

  test("keeps refund-all from a manager, who may not move money", async () => {
    const listing = await paidListing();
    const cookie = await createTestManagerSession();

    const { danger, plain } = await actionsOf(listing.id, cookie);

    assert(!(danger + plain).includes(hrefFor(listing.id, "refund-all")));
  });

  test("keeps refund-all off a listing that takes no money", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Free",
    });

    const { danger, plain } = await actionsOf(listing.id);

    assert(!(danger + plain).includes(hrefFor(listing.id, "refund-all")));
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

    says(plain, `href="/admin/emails?`);
    says(plain, "Email");
  });

  test("is not offered when the listing has nobody on it", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Empty",
    });

    const { danger, plain } = await actionsOf(listing.id);

    assert(!(danger + plain).includes(`href="/admin/emails?`));
  });

  test("is not offered to a manager, even with someone to email", async () => {
    const listing = await listingWithSomeoneToEmail();
    const cookie = await createTestManagerSession();

    const { danger, plain } = await actionsOf(listing.id, cookie);

    assert(!(danger + plain).includes(`href="/admin/emails?`));
  });
});

describeWithEnv("the actions that end a listing", { db: true }, () => {
  test("puts deactivate and delete in the danger zone", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Endable",
    });

    const { danger, plain } = await actionsOf(listing.id);

    says(danger, hrefFor(listing.id, "deactivate"));
    says(danger, hrefFor(listing.id, "delete"));
    assert(!plain.includes(hrefFor(listing.id, "deactivate")));
    assert(!plain.includes(hrefFor(listing.id, "delete")));
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

    says(plain, hrefFor(listing.id, "reactivate"));
    assert(!danger.includes(hrefFor(listing.id, "reactivate")));
  });
});
