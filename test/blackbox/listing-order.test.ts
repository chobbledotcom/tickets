/**
 * The order of the listings, as the owner sets it on the listings page with
 * the arrows. A drop posts the same move forms (see drag-to-reorder.test.ts).
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { addListing, openApi } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const LIST = "/admin/listings";

/** The listing ids in the order a page shows them, read off the handles. */
const shownIds = (html: string): number[] =>
  [...html.matchAll(/data-sortable-anchor="(\d+)"/g)].map((match) =>
    Number(match[1]),
  );

/** An owner with three undated listings, which the automatic order sorts by
 *  name: Alpha, Bravo, Charlie. */
const openShop = async () => {
  const app = createApp(inProcess);
  await app.logIn();
  const api = await openApi(app);
  const add = async (name: string) =>
    (await addListing(api, { max_attendees: 10, name })).id;
  const listings = {
    alpha: await add("Alpha"),
    bravo: await add("Bravo"),
    charlie: await add("Charlie"),
  };
  return { add, app, listings };
};

/** Press the move form a listing's row offers, naming another anchor when
 *  the move is a drop. */
const move = (
  app: App,
  id: number,
  place: string,
  anchor: number,
  extra = {},
) =>
  app.submit(
    LIST,
    { anchor: String(anchor), ...extra },
    `/admin/listing/${id}/move-${place}`,
  );

const order = async (app: App): Promise<number[]> =>
  shownIds((await app.get(LIST)).html);

describeWithEnv("listing order", { db: true }, () => {
  test("the up arrow moves a listing before the one above", async () => {
    const { app, listings } = await openShop();

    const moved = await move(app, listings.charlie, "before", listings.bravo);

    expect(moved.location).toMatch(/^\/admin\/listings\?flash=/);
    expect(await order(app)).toEqual([
      listings.alpha,
      listings.charlie,
      listings.bravo,
    ]);
  });

  test("a drop moves a listing several places, beside a listing a filter can hide", async () => {
    const { app, listings } = await openShop();

    await move(app, listings.alpha, "after", listings.charlie);

    expect(await order(app)).toEqual([
      listings.bravo,
      listings.charlie,
      listings.alpha,
    ]);
  });

  test("a new listing shows first, before the moved ones", async () => {
    const { add, app, listings } = await openShop();
    await move(app, listings.alpha, "after", listings.bravo);

    const zulu = await add("Zulu");

    expect(await order(app)).toEqual([
      zulu,
      listings.bravo,
      listings.alpha,
      listings.charlie,
    ]);
  });

  test("brings the owner back to the page with its filters", async () => {
    const { app, listings } = await openShop();

    const moved = await move(app, listings.alpha, "after", listings.bravo, {
      returnUrl: `${LIST}?type=standard`,
    });

    expect(moved.location).toMatch(/^\/admin\/listings\?type=standard&flash=/);
  });

  test("only the listings page offers the moves", async () => {
    const { app } = await openShop();

    const [listingsPage, dashboard] = await Promise.all([
      app.get(LIST),
      app.get("/admin/"),
    ]);

    expect([
      listingsPage.html.includes("data-sortable"),
      dashboard.html.includes("data-sortable"),
    ]).toEqual([true, false]);
  });
});
