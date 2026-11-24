/**
 * A shop with two discos that a parent can book together, for black-box
 * tests of the questions that ask once for each listing. The owner adds a
 * question on the questions page, and a parent books through the booking form.
 */

import { expect } from "@std/expect";
import * as v from "valibot";
import { requireValue } from "#shared/required-value.ts";
import type { Api } from "#test/blackbox/api.ts";
import {
  type App,
  createApp,
  type Fields,
  inProcess,
} from "#test/blackbox/driver.ts";
import {
  addListing,
  openApi,
  type SeededListing,
} from "#test/blackbox/seed.ts";

export type Discos = {
  api: Api;
  discoA: SeededListing;
  discoB: SeededListing;
  owner: App;
};

const addDisco = (api: Api, name: string, unitPrice: number) =>
  addListing(api, {
    max_attendees: 20,
    max_quantity: 5,
    name,
    unit_price: unitPrice,
  });

/** Two discos that a parent can book together. */
export const addDiscos = async (owner: App, api: Api, unitPrice = 0) => ({
  api,
  discoA: await addDisco(api, "Disco A", unitPrice),
  discoB: await addDisco(api, "Disco B", unitPrice),
  owner,
});

/** A shop with two free discos. */
export const openDiscos = async (): Promise<Discos> => {
  const owner = createApp(inProcess);
  await owner.logIn();
  return addDiscos(owner, await openApi(owner));
};

/** The owner adds a free-text question on the questions page. The question is
 * asked on `askedOn`, or on every listing. Gives back its number. */
export const addQuestion = async (
  owner: App,
  text: string,
  answerLevel: "booking" | "listing",
  askedOn?: SeededListing,
): Promise<number> => {
  const added = await owner.submit("/admin/questions", {
    answerLevel,
    displayType: "free_text",
    text,
  });
  const id = Number(added.location?.match(/\/admin\/questions\/(\d+)/)?.[1]);
  expect(id).toBeGreaterThan(0);
  const page = `/admin/questions/${id}`;
  await owner.submit(
    page,
    askedOn === undefined
      ? { assignAll: "on" }
      : { listingIds: String(askedOn.id) },
    `${page}/listings`,
  );
  return id;
};

/** Two discos and a "Pupil name" question that asks once for each listing. */
export type PupilShop = Discos & { readonly question: number };

/** The owner adds a "Pupil name" question that asks once for each listing. The
 * question is asked on `askedOn`, or on every listing. */
export const withPupilName = async (
  discos: Discos,
  askedOn?: SeededListing,
): Promise<PupilShop> => ({
  ...discos,
  question: await addQuestion(discos.owner, "Pupil name", "listing", askedOn),
});

/** The field of the booking form that answers a question for one listing. */
export const fieldFor = (question: number, listing: SeededListing): string =>
  `question${question}_listing${listing.id}`;

/** The pupil names for disco A and disco B. A `null` name leaves that field
 * out of the post. */
export const pupilNames = (
  { discoA, discoB, question }: PupilShop,
  forA: string | null,
  forB: string | null,
): Fields => ({
  [fieldFor(question, discoA)]: forA,
  [fieldFor(question, discoB)]: forB,
});

/** A parent books places on both discos through the booking form. */
export const book = (
  { discoA, discoB }: Discos,
  counts: [number, number],
  answers: Fields,
  buyer: App = createApp(inProcess),
) =>
  buyer.submit(`/ticket/${discoA.slug}+${discoB.slug}`, {
    email: "pta@example.com",
    name: "PTA Parent",
    [`quantity${discoA.id}`]: String(counts[0]),
    [`quantity${discoB.id}`]: String(counts[1]),
    ...answers,
  });

/** A parent books with these pupil names, and reads the page that the form
 * sends them to. */
export const bookAndRead = async (
  shop: PupilShop,
  counts: [number, number],
  forA: string | null,
  forB: string | null,
): Promise<string> => {
  const buyer = createApp(inProcess);
  const sent = await book(shop, counts, pupilNames(shop, forA, forB), buyer);
  const page = await buyer.get(
    requireValue(sent.location, "The booking form sent the parent nowhere"),
  );
  return page.html;
};

const Bookings = v.object({
  attendees: v.array(v.looseObject({ id: v.number() })),
});

/** The numbers of the attendees booked on a listing. */
export const attendeeIds = async (api: Api, listing: SeededListing) =>
  v
    .parse(
      Bookings,
      (await api.get(`/api/admin/listings/${listing.id}/attendees`)).body,
    )
    .attendees.map(({ id }) => id);

/** The text of an admin page with its tags taken out. */
export const textOf = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** The text of the attendee page of the first booking on a listing, disco A
 * when no listing is named. */
export const attendeePage = async (
  { api, discoA, owner }: Discos,
  listing: SeededListing = discoA,
) => {
  const [id] = await attendeeIds(api, listing);
  const page = await owner.get(
    `/admin/attendees/${requireValue(id, `Listing ${listing.id} has no booking`)}`,
  );
  return textOf(page.html);
};

/** A free "Glow Pack" listing that a buyer can add under each of `parents`. */
export const addGlowPack = async (
  { api }: Discos,
  parents: readonly SeededListing[],
): Promise<SeededListing> => {
  const child = await addListing(api, {
    max_attendees: 20,
    max_quantity: 5,
    name: "Glow Pack",
    unit_price: 0,
  });
  for (const parent of parents) {
    await api.put(`/api/admin/listings/${parent.id}`, {
      child_listing_ids: [child.id],
    });
  }
  return child;
};
