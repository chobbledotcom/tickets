import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { addBooking, addListing, openApi } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const Roster = v.object({
  attendees: v.array(
    v.looseObject({ id: v.number(), name: v.string(), quantity: v.number() }),
  ),
});

describeWithEnv("a shop set up through the admin API", { db: true }, () => {
  const openShop = async () => {
    const owner = createApp(inProcess);
    await owner.logIn();
    const api = await openApi(owner);
    const listing = await addListing(api, {
      max_attendees: 10,
      max_quantity: 4,
      name: "Quiz Night",
      unit_price: 500,
    });
    return { api, listing };
  };

  test("a booking that the API adds shows on the listing's roster with its places", async () => {
    const { api, listing } = await openShop();
    const id = await addBooking(api, listing, { name: "Ada", quantity: 3 });

    const answer = await api.get(`/api/admin/listings/${listing.id}/attendees`);
    expect(answer.status).toBe(200);
    const { attendees } = v.parse(Roster, answer.body);
    expect(
      attendees.map(({ id: found, name, quantity }) => [found, name, quantity]),
    ).toEqual([[id, "Ada", 3]]);
  });

  test("the API refuses a booking above what the listing allows, and seeding says why", async () => {
    const { api, listing } = await openShop();
    await expect(
      addBooking(api, listing, { name: "Ada", quantity: 5 }),
    ).rejects.toThrow("lines[0].quantity is more than the listing allows");
    const roster = v.parse(
      Roster,
      (await api.get(`/api/admin/listings/${listing.id}/attendees`)).body,
    );
    expect(roster.attendees).toEqual([]);
  });
});
