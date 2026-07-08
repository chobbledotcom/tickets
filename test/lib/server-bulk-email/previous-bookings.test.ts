import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { adminGet, describeWithEnv } from "#test-utils";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("server previous bookings", { db: true }, () => {
  test("the contact summary reports the capped number shown", async () => {
    const listing = await createTestListing({
      maxAttendees: 30,
      name: "Many Previous",
    });
    const { attendee: viewer } = await createTestAttendeeDirect(
      listing.id,
      "Viewer",
      "many-previous@example.com",
    );
    const previous = [];
    for (let index = 0; index < 22; index += 1) {
      previous.push(
        await createTestAttendeeDirect(
          listing.id,
          `Previous ${index}`,
          "many-previous@example.com",
        ),
      );
    }

    const html = await (await adminGet(`/admin/attendees/${viewer.id}`)).text();
    expect(html).toContain("Previous bookings shown:</strong> 20");
    expect(html).not.toContain(
      `href="/admin/attendees/${previous[0]!.attendee.id}"`,
    );
    expect(html).toContain(
      `href="/admin/attendees/${previous[previous.length - 1]!.attendee.id}"`,
    );
  });
});
