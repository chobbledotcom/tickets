/**
 * Setting up a shop the way another system does: through the admin JSON API
 * with a key that the owner made on the keys page. A test that uses these
 * helpers imports nothing from `src/` and writes nothing to the database.
 */

import * as v from "valibot";
import { type Answer, type Api, createApi } from "#test/blackbox/api.ts";
import type { App } from "#test/blackbox/driver.ts";

/** A listing as the API names it: the number in its address, and the name
 * its public address ends in. */
export interface SeededListing {
  id: number;
  slug: string;
}

const KEY_SHOWN_ONCE = /<pre><code>([A-Za-z0-9_-]+)<\/code><\/pre>/;

/** The owner makes an API key on the keys page and keeps the one copy that the
 * page shows. The owner must be logged in on `app`. */
export const openApi = async (app: App, name = "seed"): Promise<Api> => {
  const made = await app.submit("/admin/api-keys", { name });
  if (made.status !== 302 || made.location === null) {
    throw new Error(
      `Making the API key answered ${made.status}, not a redirect.`,
    );
  }
  const key = (await app.get(made.location)).html.match(KEY_SHOWN_ONCE)?.[1];
  if (key === undefined) throw new Error(`The keys page shows no ${name} key.`);
  return createApi(app.target, key);
};

/** The record of a create that answered 201. Any other answer fails and shows
 * what the API said. */
const created = <Schema extends v.GenericSchema>(
  what: string,
  answer: Answer,
  schema: Schema,
): v.InferOutput<Schema> => {
  if (answer.status !== 201) {
    throw new Error(
      `Adding the ${what} answered ${answer.status}: ${JSON.stringify(answer.body)}`,
    );
  }
  return v.parse(schema, answer.body);
};

const ListingAnswer = v.object({
  listing: v.looseObject({ id: v.number(), slug: v.string() }),
});

const AttendeeAnswer = v.object({
  attendee: v.looseObject({ id: v.number() }),
});

/** The fields of a new listing, as the API reads them. */
export type ListingFields = { max_attendees: number; name: string } & Record<
  string,
  unknown
>;

/** Add a standard listing. A field in `fields` replaces the default. */
export const addListing = async (
  api: Api,
  fields: ListingFields,
): Promise<SeededListing> => {
  const { listing } = created(
    "listing",
    await api.post("/api/admin/listings", {
      listing_type: "standard",
      ...fields,
    }),
    ListingAnswer,
  );
  return { id: listing.id, slug: listing.slug };
};

const GroupAnswer = v.object({ group: v.looseObject({ id: v.number() }) });

/** Add a group and give back its number. */
export const addGroup = async (api: Api, name: string): Promise<number> =>
  created(
    "group",
    await api.post("/api/admin/groups", { max_attendees: 10, name }),
    GroupAnswer,
  ).group.id;

const ImageAnswer = v.object({ image: v.looseObject({ id: v.number() }) });

/** A real 1×1 PNG as base64 text, the smallest file an image create takes. */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Add an image to the library, show it on one record after the record's
 * other images, and give back its number. The site needs image storage. */
export const addImage = async (
  api: Api,
  name: string,
  item: { item_id: number; item_type: string },
): Promise<number> => {
  const { id } = created(
    "image",
    await api.post("/api/admin/images", {
      content_type: "image/png",
      file: ONE_PIXEL_PNG,
      name,
    }),
    ImageAnswer,
  ).image;
  const linked = await api.put(`/api/admin/images/${id}`, { items: [item] });
  if (linked.status !== 200) {
    throw new Error(
      `Showing image ${id} answered ${linked.status}: ${JSON.stringify(linked.body)}`,
    );
  }
  return id;
};

/** The fields of a new booking: who books, and how many places. */
export interface BookingFields {
  email?: string;
  name: string;
  quantity?: number;
}

/** Book places on a listing for one person. The booking goes through the
 * same validation as any other booking, so the listing must allow the
 * quantity. Gives back the number of the booking. */
export const addBooking = async (
  api: Api,
  listing: SeededListing,
  { email = "buyer@example.com", name, quantity = 1 }: BookingFields,
): Promise<number> =>
  created(
    "booking",
    await api.post("/api/admin/attendees", {
      email,
      lines: [{ listingId: listing.id, quantity }],
      name,
    }),
    AttendeeAnswer,
  ).attendee.id;
