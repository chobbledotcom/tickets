import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createApp, inProcess } from "#test/blackbox/driver.ts";
import { addListing, openApi } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The number the quantity box of one listing shows as chosen. */
const chosenQuantity = (html: string, id: number): number => {
  const box = html.match(
    new RegExp(`<select name="quantity${id}">([\\s\\S]*?)</select>`),
  );
  const chosen = box?.[1]?.match(/<option value="(\d+)" selected>/);
  if (!chosen) throw new Error(`No quantity box is set for listing ${id}.`);
  return Number(chosen[1]);
};

describeWithEnv("booking page prefill", { db: true }, () => {
  const openShop = async () => {
    const owner = createApp(inProcess);
    await owner.logIn();
    const listing = await addListing(await openApi(owner), {
      max_attendees: 50,
      max_quantity: 10,
      name: "Quiz Night",
      unit_price: 500,
    });
    return { app: createApp(inProcess), listing };
  };

  test("a visitor who follows a link with a quantity lands with that quantity chosen", async () => {
    const { app, listing } = await openShop();
    const base = await app.get(`/ticket/${listing.slug}`);
    expect(chosenQuantity(base.html, listing.id)).toBe(0);

    const linked = await app.get(`/ticket/${listing.slug}?q_${listing.id}=4`);
    expect(linked.status).toBe(200);
    expect(chosenQuantity(linked.html, listing.id)).toBe(4);
  });

  test("a quantity that is not a whole number above zero changes nothing", async () => {
    const { app, listing } = await openShop();
    for (const bad of ["0", "-3", "abc", "2.5", ""]) {
      const page = await app.get(
        `/ticket/${listing.slug}?q_${listing.id}=${bad}`,
      );
      expect(chosenQuantity(page.html, listing.id)).toBe(0);
    }
  });

  test("a quantity for another listing changes nothing", async () => {
    const { app, listing } = await openShop();
    const page = await app.get(
      `/ticket/${listing.slug}?q_${listing.id + 50}=4`,
    );
    expect(chosenQuantity(page.html, listing.id)).toBe(0);
  });
});
