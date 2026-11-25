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
  answerLevel: AnswerLevel,
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

/** How often a question asks, as the add form names it. */
export type AnswerLevel = "booking" | "listing" | "quantity";

/** Two discos and a "Pupil name" question that asks once for each listing. */
export type PupilShop = Discos & { readonly question: number };

/** The owner adds a "Pupil name" question that asks once for each listing, or
 * once for each ticket. The question is asked on `askedOn`, or on every
 * listing. */
export const withPupilName = async (
  discos: Discos,
  askedOn?: SeededListing,
  level: AnswerLevel = "listing",
): Promise<PupilShop> => ({
  ...discos,
  question: await addQuestion(discos.owner, "Pupil name", level, askedOn),
});

/** Where a booking line comes from: the parent it is booked under, or the
 * package it is booked in. A line with neither is the listing on its own. */
export type LinePath = {
  readonly parent?: SeededListing | undefined;
  readonly packageId?: number;
  readonly ticket?: number;
};

/** The field of the booking form that answers a question for one ticket of
 * one booking line. The first ticket is 1. */
export const fieldFor = (
  question: number,
  listing: SeededListing,
  { packageId = 0, parent, ticket = 1 }: LinePath = {},
): string =>
  `question${question}_line${listing.id}_${parent?.id ?? 0}_${packageId}_ticket${ticket - 1}`;

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

/** The pupil names of a shop, ticket by ticket, on disco A then disco B. */
export const ticketNames = (
  { discoA, discoB, question }: PupilShop,
  forA: readonly string[],
  forB: readonly string[] = [],
): Fields =>
  Object.fromEntries([
    ...forA.map((name, at) => [
      fieldFor(question, discoA, { ticket: at + 1 }),
      name,
    ]),
    ...forB.map((name, at) => [
      fieldFor(question, discoB, { ticket: at + 1 }),
      name,
    ]),
  ]);

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

/** A parent books with these answers, and reads the page that the form sends
 * them to. */
export const bookAndRead = async (
  shop: Discos,
  counts: [number, number],
  answers: Fields,
): Promise<string> => {
  const buyer = createApp(inProcess);
  const sent = await book(shop, counts, answers, buyer);
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

const CreatedGroup = v.object({
  group: v.object({ id: v.number(), slug: v.string() }),
});

/** A free "Party Pack" package of `members`, each `quantity` times in one
 * pack. A hidden pack shows the buyer only its own name. */
export const addPartyPack = async (
  { api }: Discos,
  members: readonly SeededListing[],
  {
    hidden = false,
    quantity = 1,
  }: { hidden?: boolean; quantity?: number } = {},
): Promise<SeededListing> => {
  const { group } = v.parse(
    CreatedGroup,
    (
      await api.post("/api/admin/groups", {
        hide_package_listings: hidden,
        is_package: true,
        max_attendees: 10,
        name: "Party Pack",
      })
    ).body,
  );
  for (const member of members) {
    await api.put(`/api/admin/listings/${member.id}`, {
      group_ids: [group.id],
    });
  }
  await api.put(`/api/admin/groups/${group.id}`, {
    package_members: members.map((member) => ({
      listing_id: member.id,
      price: 0,
      quantity,
    })),
  });
  return group;
};
