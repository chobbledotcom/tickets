/**
 * The contact-field set and paid-status checks for the booking form: what a
 * page's own listings require, what a possible child adds without requiring,
 * and which paths through a page's packages make a listing paid.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { buildTicketListing } from "#booking/model.ts";
import type { PagePackage } from "#booking/page-packages.ts";
import type { AddOnOption } from "#db/modifier-resolve.ts";
import { fieldsApi } from "#templates/fields/ticket.ts";
import {
  buildContactFields,
  pageOrChildPaid,
  pagePaid,
} from "#templates/public/reservations/contact-fields.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** Run `fn` as though Square is the payment provider, the only provider that
 * imposes an email field on a paid order. */
const underSquare = <T>(fn: () => T): T => {
  const s = stub(fieldsApi, "getSettingCached", () => "square");
  try {
    return fn();
  } finally {
    s.restore();
  }
};

/** A listing on the page, carrying the fields its row names. */
const pageListing = (
  overrides: Record<string, unknown>,
): ReturnType<typeof buildTicketListing> =>
  buildTicketListing(testListingWithCount(overrides), false, undefined);

/** One package that bundles `memberIds`, with the given price overrides. */
const packageOver = (
  memberIds: number[],
  prices: Record<number, number>,
  dayPrices: Record<number, Record<number, number>> = {},
): PagePackage =>
  ({
    dayPrices: new Map(
      Object.entries(dayPrices).map(([id, days]) => [
        Number(id),
        new Map(Object.entries(days).map(([d, p]) => [Number(d), p])),
      ]),
    ),
    description: "",
    groupId: 1,
    hideListings: true,
    memberListingIds: memberIds,
    name: "Bundle",
    prices: new Map(Object.entries(prices).map(([id, p]) => [Number(id), p])),
    quantities: new Map(),
    slug: "bundle",
    terms: "",
  }) as PagePackage;

const paidInput = (
  listings: ReturnType<typeof buildTicketListing>[],
  packages: PagePackage[] = [],
  standaloneRowIds: number[] = [],
  addOns?: AddOnOption[],
) => ({
  addOns,
  listings,
  packages,
  standaloneRowIds: new Set(standaloneRowIds),
});

const paidAddOn = { requiresPayment: true } as AddOnOption;

describe("contact-fields", () => {
  describe("buildContactFields", () => {
    test("keeps the page listings' fields required", () => {
      const fields = buildContactFields(
        [
          pageListing({ fields: "email", id: 1 }),
          pageListing({ fields: "phone", id: 2 }),
        ],
        undefined,
        false,
        false,
      );
      expect(
        fields.map((f) => ({ name: f.name, required: f.required })),
      ).toEqual([
        { name: "name", required: true },
        { name: "email", required: true },
        { name: "phone", required: true },
      ]);
    });

    test("adds a possible child's stricter fields, not required", () => {
      const fields = buildContactFields(
        [pageListing({ fields: "email", id: 1 })],
        new Map([[1, [pageListing({ fields: "email,address", id: 2 })]]]),
        false,
        false,
      );
      const address = fields.find((f) => f.name === "address");
      expect(address?.required).toBe(false);
      expect(fields.find((f) => f.name === "email")?.required).toBe(true);
    });

    test("renders the provider email required on a paid page under Square", () => {
      const fields = underSquare(() =>
        buildContactFields(
          [pageListing({ fields: "", id: 1 })],
          undefined,
          true,
          true,
        ),
      );
      expect(fields.find((f) => f.name === "email")?.required).toBe(true);
    });

    test("renders the provider email present but optional on a free page with a paid child", () => {
      // The page itself is free, so its email must not block submission; a
      // paid child still needs the box on screen for when the buyer picks it.
      const fields = underSquare(() =>
        buildContactFields(
          [pageListing({ fields: "", id: 1 })],
          new Map([[1, [pageListing({ fields: "", id: 2, unit_price: 5 })]]]),
          false,
          true,
        ),
      );
      expect(fields.find((f) => f.name === "email")?.required).toBe(false);
      expect(fields.some((f) => f.name === "email")).toBe(true);
    });

    test("omits the provider email on a free page with no paid child", () => {
      const fields = underSquare(() =>
        buildContactFields(
          [pageListing({ fields: "", id: 1 })],
          undefined,
          false,
          false,
        ),
      );
      expect(fields.some((f) => f.name === "email")).toBe(false);
    });
  });

  describe("pagePaid", () => {
    test("a listing's own price pays the page", () => {
      expect(
        pagePaid(paidInput([pageListing({ id: 1, unit_price: 500 })])),
      ).toBe(true);
    });

    test("nothing priced leaves the page free", () => {
      expect(pagePaid(paidInput([pageListing({ id: 1 })]))).toBe(false);
    });

    test("a package's flat price pays a member the page bundles", () => {
      const member = pageListing({ id: 1 });
      expect(
        pagePaid(paidInput([member], [packageOver([1], { 1: 700 })])),
      ).toBe(true);
    });

    test("a package's explicit free price makes the bundled path free", () => {
      const member = pageListing({ id: 1, unit_price: 500 });
      expect(pagePaid(paidInput([member], [packageOver([1], { 1: 0 })]))).toBe(
        false,
      );
    });

    test("the member's own price still counts beside its bundle row", () => {
      const member = pageListing({ id: 1, unit_price: 500 });
      expect(
        pagePaid(paidInput([member], [packageOver([1], { 1: 0 })], [1])),
      ).toBe(true);
    });

    test("a day-price override pays a customisable member", () => {
      const member = pageListing({
        customisable_days: true,
        day_prices: { 2: 0 },
        id: 1,
      });
      expect(
        pagePaid(
          paidInput([member], [packageOver([1], {}, { 1: { 2: 300 } })]),
        ),
      ).toBe(true);
    });

    test("a paid add-on pays the page on its own", () => {
      expect(
        pagePaid(paidInput([pageListing({ id: 1 })], [], [], [paidAddOn])),
      ).toBe(true);
    });
  });

  describe("pageOrChildPaid", () => {
    test("a free page with a paid child still needs the provider email", () => {
      expect(
        pageOrChildPaid({
          childrenByParentId: new Map([
            [1, [pageListing({ id: 2, unit_price: 5 })]],
          ]),
          ...paidInput([pageListing({ id: 1 })]),
        }),
      ).toBe(true);
    });

    test("a free page with no paid child does not", () => {
      expect(
        pageOrChildPaid({
          childrenByParentId: new Map(),
          ...paidInput([pageListing({ id: 1 })]),
        }),
      ).toBe(false);
    });
  });
});
