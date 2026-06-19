import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { updateCheckedIn } from "#shared/db/attendees.ts";
import {
  adminGet,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("server (listing export check-in filter)", { db: true }, () => {
  /** A listing with one checked-in (AliceIn) and one not (BobOut). */
  const setup = async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Gala",
      thankYouUrl: "https://example.com",
    });
    const { attendee: alice } = await createTestAttendeeDirect(
      listing.id,
      "AliceIn",
      "alice@example.com",
    );
    await createTestAttendeeDirect(listing.id, "BobOut", "bob@example.com");
    await updateCheckedIn(alice.id, listing.id, true);
    return listing;
  };

  test("?checkin=in exports only checked-in attendees", async () => {
    const listing = await setup();
    const { response } = await adminGet(
      `/admin/listing/${listing.id}/export?checkin=in`,
    );
    const csv = await response.text();
    expect(csv).toContain("AliceIn");
    expect(csv).not.toContain("BobOut");
  });

  test("?checkin=out exports only checked-out attendees", async () => {
    const listing = await setup();
    const { response } = await adminGet(
      `/admin/listing/${listing.id}/export?checkin=out`,
    );
    const csv = await response.text();
    expect(csv).toContain("BobOut");
    expect(csv).not.toContain("AliceIn");
  });

  test("no check-in filter exports everyone", async () => {
    const listing = await setup();
    const { response } = await adminGet(`/admin/listing/${listing.id}/export`);
    const csv = await response.text();
    expect(csv).toContain("AliceIn");
    expect(csv).toContain("BobOut");
  });
});
