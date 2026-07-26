import { expectRedirect } from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/**
 * Books a plain single-ticket listing (name + email only) and asserts the
 * redirect lands on its `thankYouUrl` — the "happy path" shared by
 * `ticket-slug-post.test.ts`'s "creates attendee and redirects to thank you
 * page" and `ticket-terms-checkbox.test.ts`'s "succeeds without checkbox when
 * no terms configured" (the same booking, just under a different heading).
 */
export const expectBasicTicketBookingRedirectsToThanks =
  async (): Promise<void> => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com/thanks",
    });
    const response = await submitTicketForm(listing.slug, {
      email: "john@example.com",
      name: "John Doe",
    });
    expectRedirect(response, "https://example.com/thanks");
  };
