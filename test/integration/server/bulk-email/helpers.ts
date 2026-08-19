import { encryptWithOwnerKey } from "#crypto/keys.ts";
import { hashEmail, unsubscribeHash } from "#db/contact-preferences.ts";
import { settings } from "#db/settings.ts";
import { type BulkEmailDraft, serializeDraft } from "#shared/bulk-email.ts";
import {
  createDailyTestAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Configure the owner's own (bulk-capable) email provider. */
export const useResend = () =>
  settings.setForTest({
    email_api_key: "re_key",
    email_from_address: "tickets@example.com",
    email_provider: "resend",
  });

export const seedSingleAttendeeListing = async () => {
  const listing = await createTestListing({ maxAttendees: 50, name: "Solo" });
  await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
  return listing;
};

/** A daily listing with one booking on 2 March 2026 and nothing on any other
 * day, for the listing-day target's reachable and 404 cases. */
export const seedDailyListingBookedOnOneDay = async () => {
  const { listing } = await createDailyTestAttendee(
    "Rachel",
    "rachel@example.com",
    "2026-03-02",
    { maxAttendees: 50, name: "Term" },
  );
  return listing;
};

export const seedListingWithAttendees = async () => {
  const listing = await createTestListing({ maxAttendees: 50, name: "Gig" });
  await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
  await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");
  return listing;
};

/**
 * Seed a stored draft the way production does: encrypted with the owner's
 * public key so the route's keypair-based decrypt can read it back.
 */
export const seedDraft = async (draft: BulkEmailDraft) =>
  settings.setForTest({
    bulk_email_draft: await encryptWithOwnerKey(
      serializeDraft(draft),
      settings.publicKey,
    ),
  });

/** Seed a two-attendee listing where one attendee has unsubscribed, then save
 * a marketing draft targeting it. Shared by the preview and send tests that
 * own the direct cover of the skipping branches. */
export const seedMarketingDraftWithUnsubscriber = async () => {
  const listing = await seedListingWithAttendees();
  await unsubscribeHash(await hashEmail("alice@example.com"));
  await adminFormPost("/admin/emails/preview", {
    body: "Promo",
    listing_id: String(listing.id),
    marketing: "1",
    subject: "Sale",
  });
  return listing;
};
