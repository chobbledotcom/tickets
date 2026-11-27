/** Which booked listings a "Pupil name" question asks, page shape by page
 * shape. Each shape is checked forwards and backwards:
 * - forwards: the fields that the booking page shows, then an order that
 *   answers each one is booked, and an order that leaves one out is refused
 *   with that listing's name;
 * - backwards: the owner reads each answer exactly once on the attendee
 *   page. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requireValue } from "#shared/required-value.ts";
import {
  addGlowPack,
  addPartyPack,
  attendeeIds,
  attendeePage,
  type Discos,
  fieldFor,
  openDiscos,
  type PupilShop,
  textOf,
  withPupilName,
} from "#test/blackbox/discos.ts";
import { createApp, type Fields, inProcess } from "#test/blackbox/driver.ts";
import { addListing, type SeededListing } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** A booking line: a listing, and the parent it is booked under. */
type Line = {
  readonly listing: SeededListing;
  readonly packageId?: number;
  readonly parent?: SeededListing;
};

/** One page shape: the page, the lines it asks about in page order, the
 * places that an order books and the name it gives each asked line, the line
 * whose answer the refusal test leaves out, and the listing whose attendee
 * page shows the answers. */
type Shape = {
  readonly asked: readonly Line[];
  readonly booked: SeededListing;
  readonly names: readonly string[];
  readonly order: Fields;
  readonly owed: Line | null;
  readonly path: string;
  readonly shows: readonly string[];
};

const CONTACT = { email: "pta@example.com", name: "PTA Parent" };

/** The line fields of a question on a page, in page order. A page that asks
 * about no line has none. */
const fieldsOn = (html: string, question: number): string[] =>
  html.match(
    new RegExp(`(?<=name=")question${question}_line[\\d_]+_ticket\\d+`, "g"),
  ) ?? [];

const fieldOfLine = (shop: PupilShop, { listing, ...path }: Line) =>
  fieldFor(shop.question, listing, path);

const pageOf = (path: string) => createApp(inProcess).get(path);

const bothDiscos = ({ discoA, discoB }: Discos) =>
  `/ticket/${discoA.slug}+${discoB.slug}`;

/** A whole order of a shape: its places, and its name for each asked line. */
const wholeOrder = (shop: PupilShop, shape: Shape): Fields => ({
  ...CONTACT,
  ...shape.order,
  ...Object.fromEntries(
    shape.asked.map((line, at) => [fieldOfLine(shop, line), shape.names[at]]),
  ),
});

const HALL = { max_attendees: 20, name: "Hall", unit_price: 0 };

/** A package of the Hall, that hides or shows its member. */
const hallPackage =
  (hidden: boolean) =>
  async (discos: Discos): Promise<[PupilShop, Shape]> => {
    const member = await addListing(discos.api, HALL);
    const pack = await addPartyPack(discos, [member], { hidden });
    const shop = await withPupilName(discos);
    const line = { listing: member, packageId: pack.id };
    return [
      shop,
      {
        asked: hidden ? [] : [line],
        booked: member,
        names: hidden ? [] : ["Ava"],
        order: { [`packageQuantity${pack.id}`]: "1" },
        owed: hidden ? null : line,
        path: `/ticket/${pack.slug}`,
        shows: hidden ? [] : ["Pupil name (Hall in Party Pack) Ava"],
      },
    ];
  };

const SHAPES: [string, (discos: Discos) => Promise<[PupilShop, Shape]>][] = [
  [
    "a question asked on disco B only",
    async (discos) => {
      const shop = await withPupilName(discos, discos.discoB);
      return [
        shop,
        {
          asked: [{ listing: discos.discoB }],
          booked: discos.discoB,
          names: ["Ben"],
          order: {
            [`quantity${discos.discoA.id}`]: "1",
            [`quantity${discos.discoB.id}`]: "1",
          },
          owed: { listing: discos.discoB },
          path: bothDiscos(discos),
          shows: ["Pupil name (Disco B) Ben"],
        },
      ];
    },
  ],
  [
    "a child that the buyer adds under disco A",
    async (discos) => {
      const glow = await addGlowPack(discos, [discos.discoA]);
      const shop = await withPupilName(discos);
      return [
        shop,
        {
          asked: [
            { listing: discos.discoA },
            { listing: glow, parent: discos.discoA },
          ],
          booked: discos.discoA,
          names: ["Ava", "Kit"],
          order: { [`quantity${discos.discoA.id}`]: "1" },
          owed: { listing: glow, parent: discos.discoA },
          path: `/ticket/${discos.discoA.slug}`,
          shows: [
            "Pupil name (Disco A) Ava",
            "Pupil name (Glow Pack with Disco A) Kit",
          ],
        },
      ];
    },
  ],
  [
    "a child of both discos, added under each",
    async (discos) => {
      const glow = await addGlowPack(discos, [discos.discoA, discos.discoB]);
      const shop = await withPupilName(discos);
      return [
        shop,
        {
          asked: [
            { listing: discos.discoA },
            { listing: discos.discoB },
            { listing: glow, parent: discos.discoA },
            { listing: glow, parent: discos.discoB },
          ],
          booked: discos.discoA,
          names: ["Ava", "Ben", "Kit", "Kim"],
          order: {
            [`quantity${discos.discoA.id}`]: "1",
            [`quantity${discos.discoB.id}`]: "1",
          },
          owed: { listing: glow, parent: discos.discoA },
          path: bothDiscos(discos),
          shows: [
            "Pupil name (Disco A) Ava",
            "Pupil name (Disco B) Ben",
            "Pupil name (Glow Pack with Disco A) Kit",
            "Pupil name (Glow Pack with Disco B) Kim",
          ],
        },
      ];
    },
  ],
  ["a package that hides its member", hallPackage(true)],
  ["a package that shows its member", hallPackage(false)],
  [
    "a package that hides its member, beside disco A",
    async (discos) => {
      const member = await addListing(discos.api, HALL);
      const pack = await addPartyPack(discos, [member], { hidden: true });
      const shop = await withPupilName(discos);
      return [
        shop,
        {
          asked: [{ listing: discos.discoA }],
          booked: discos.discoA,
          names: ["Ava"],
          order: {
            [`packageQuantity${pack.id}`]: "1",
            [`quantity${discos.discoA.id}`]: "1",
          },
          owed: { listing: discos.discoA },
          path: `/ticket/${pack.slug}+${discos.discoA.slug}`,
          shows: ["Pupil name (Disco A) Ava"],
        },
      ];
    },
  ],
  [
    "a package beside disco A, whose other member is disco A's child",
    async (discos) => {
      const hall = await addListing(discos.api, HALL);
      const glow = await addGlowPack(discos, [discos.discoA]);
      const pack = await addPartyPack(discos, [hall, glow]);
      const shop = await withPupilName(discos);
      const child: Line = { listing: glow, parent: discos.discoA };
      return [
        shop,
        {
          asked: [
            { listing: hall, packageId: pack.id },
            { listing: discos.discoA },
            child,
          ],
          booked: discos.discoA,
          names: ["Hal", "Ava", "Kim"],
          order: {
            [`packageQuantity${pack.id}`]: "1",
            [`quantity${discos.discoA.id}`]: "1",
          },
          owed: child,
          path: `/ticket/${pack.slug}+${discos.discoA.slug}`,
          shows: [
            "Pupil name (Hall in Party Pack) Hal",
            "Pupil name (Disco A) Ava",
            "Pupil name (Glow Pack with Disco A) Kim",
          ],
        },
      ];
    },
  ],
];

const [ASKED_ON_B, CHILD_OF_A, CHILD_OF_BOTH, , SHOWN_PACKAGE] = SHAPES;

/** The shapes that owe an answer, and the listing that the refusal names. */
const REFUSALS: [(typeof SHAPES)[number], string][] = [
  [requireValue(ASKED_ON_B, "shape"), "Disco B"],
  [requireValue(CHILD_OF_A, "shape"), "Glow Pack with Disco A"],
  [requireValue(CHILD_OF_BOTH, "shape"), "Glow Pack with Disco A"],
  [requireValue(SHOWN_PACKAGE, "shape"), "Hall in Party Pack"],
];

const timesIn = (text: string, part: string) => text.split(part).length - 1;

describeWithEnv(
  "the listings that a question asks once for each",
  { db: true },
  () => {
    for (const [name, build] of SHAPES) {
      test(`${name}: the page asks each, an order that answers each is booked, and each answer shows once`, async () => {
        const discos = await openDiscos();
        const [shop, shape] = await build(discos);

        const page = await pageOf(shape.path);
        const sent = await createApp(inProcess).submit(
          shape.path,
          wholeOrder(shop, shape),
        );

        expect(fieldsOn(page.html, shop.question)).toEqual(
          shape.asked.map((line) => fieldOfLine(shop, line)),
        );
        expect(sent.status).toBe(302);
        const shown = await attendeePage(discos, shape.booked);
        expect(shape.shows.map((part) => timesIn(shown, part))).toEqual(
          shape.shows.map(() => 1),
        );
        expect(timesIn(shown, "Pupil name (")).toBe(shape.shows.length);
      });
    }

    for (const [[name, build], listingName] of REFUSALS) {
      test(`${name}: an order that leaves out the answer for ${listingName} is refused, and books nothing`, async () => {
        const discos = await openDiscos();
        const [shop, shape] = await build(discos);
        const owed = requireValue(shape.owed, `${name} owes no answer`);
        const buyer = createApp(inProcess);

        const sent = await buyer.submit(shape.path, {
          ...wholeOrder(shop, shape),
          [fieldOfLine(shop, owed)]: null,
        });
        const shown = await buyer.get(
          requireValue(
            sent.location,
            "The booking form sent the parent nowhere",
          ),
        );

        expect(textOf(shown.html)).toContain(
          `Please answer: Pupil name (${listingName})`,
        );
        expect(await attendeeIds(discos.api, shape.booked)).toEqual([]);
      });
    }
  },
);
