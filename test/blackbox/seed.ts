/**
 * Setting up a shop the way its owner does: through the pages and forms of
 * the admin. Every function here reads what the page offers and sends what a
 * browser sends, so a test that uses them imports nothing from `src/`.
 */

import type { App } from "#test/blackbox/driver.ts";

/** A listing as the owner sees it: the number in its admin address, and the
 * name its public address ends in. */
export interface SeededListing {
  id: number;
  slug: string;
}

/** The owner adds a listing through the "Add listing" form, and the public
 * address is read from the listing's admin page. The owner must be logged in
 * on `app`. */
export const addListing = async (
  app: App,
  fields: { maxAttendees: string; name: string; unitPrice: string } & Record<
    string,
    string
  >,
): Promise<SeededListing> => {
  const saved = await app.submit(
    "/admin/listing/new?template=custom",
    fields,
    "/admin/listing",
  );
  if (saved.status !== 302) {
    throw new Error(
      `Adding the listing answered ${saved.status}, not a redirect.`,
    );
  }
  const dashboard = await app.get("/admin/listings");
  const link = dashboard.html.match(
    new RegExp(`href="/admin/listing/(\\d+)"[^>]*>\\s*${fields.name}`),
  );
  if (link === null) {
    throw new Error(`The listings page does not show "${fields.name}".`);
  }
  const id = Number(link[1]);
  const page = await app.get(`/admin/listing/${id}`);
  const slug = page.html.match(/\/ticket\/([a-z0-9-]+)/)?.[1];
  if (slug === undefined) {
    throw new Error(`The page of listing ${id} holds no public address.`);
  }
  return { id, slug };
};
