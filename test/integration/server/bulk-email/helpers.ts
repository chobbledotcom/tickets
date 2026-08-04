import { type BulkEmailDraft, serializeDraft } from "#shared/bulk-email.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { settings } from "#shared/db/settings.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
