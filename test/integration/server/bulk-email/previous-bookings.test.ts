import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";
import {
  latestAttendee,
  submitBuyerOrder,
} from "../../../lib/server-reservation/helpers.ts";

describeWithEnv("server previous bookings", { db: true }, () => {
  afterEach(() => resetStripeClient());

  test("the contact summary reports the capped number shown", async () => {
    const listing = await createTestListing({
      maxAttendees: 200,
      name: "Many Previous",
    });
    const { attendee: viewer } = await createTestAttendeeDirect(
      listing.id,
      "Viewer",
      "many-previous@example.com",
    );
    const previous = [];
    for (let index = 0; index < 102; index += 1) {
      previous.push(
        await createTestAttendeeDirect(
          listing.id,
          `Previous ${index}`,
          "many-previous@example.com",
        ),
      );
    }

    const html = await (await adminGet(`/admin/attendees/${viewer.id}`)).text();
    expect(html).toContain("Previous bookings shown:</strong> 100");
    // The oldest booking falls outside the cap window and is not linked.
    expect(html).not.toContain(
      `href="/admin/attendees/${previous[0]!.attendee.id}"`,
    );
    // The newest booking is inside the cap window and is linked.
    expect(html).toContain(
      `href="/admin/attendees/${previous[previous.length - 1]!.attendee.id}"`,
    );
  });

  test("the total value does not add owed balance to the gross booking value", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Owed Previous",
      thankYouUrl: "https://example.com",
      unitPrice: 1000,
    });
    const response = await submitBuyerOrder(listing, {
      email: "owed-previous@example.com",
    });
    expect(response.status).toBe(302);
    const previous = await latestAttendee();
    expect(previous.pricePaid).toBe(1000);
    expect(previous.remainingBalance).toBe(1000);

    const { attendee: viewer } = await createTestAttendeeDirect(
      listing.id,
      "Viewer",
      "owed-previous@example.com",
    );

    const html = await (await adminGet(`/admin/attendees/${viewer.id}`)).text();
    expect(html).toContain(`href="/admin/attendees/${previous.id}"`);
    expect(html).toContain('<td class="col-amount">£10</td>');
    expect(html).not.toContain('<td class="col-amount">£20</td>');
  });
});
