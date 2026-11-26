import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { expectHtml, followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import {
  signedMeta,
  signMeta,
  type TestListingOverrides,
} from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { createStripeListing } from "#test-utils/stripe-listing.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";
import type { Group, ListingWithCount } from "#types";

/** The checkout session a case pays with: its ids, its total, and the buyer
 *  whose details its metadata signs. */
type SessionCase = {
  readonly amountTotal: number;
  readonly buyer: string;
  readonly email: string;
  /** The metadata shape the session carries: a bare price proof over the
   *  fields the case names, or the full record a Stripe webhook writes. */
  readonly metadata: "proof" | "webhook";
  readonly paymentIntent: string;
  readonly sessionId: string;
};

/** One page the success route must render, as `expectHtml` reads it. */
type PageExpectation = {
  readonly contains: string[];
  readonly notContains?: string[];
};

/** One payment the success page replays: the listings the order sells, the
 *  session that paid, and what each request must render. */
type SuccessCase = {
  /** Ticket lines: which listing, the price paid, and how many tickets. */
  readonly lines: readonly (readonly [
    listing: number,
    price: number,
    quantity: number,
  ])[];
  readonly listings: readonly TestListingOverrides[];
  readonly name: string;
  /** The replay leaves the order one attendee, the one the payment bought. */
  readonly oneAttendee?: boolean;
  /** The hidden package the order's listing belongs to. The item's `k: "p"`
   *  edge and its group id let the webhook's tree revalidation resolve the
   *  member as a package member rather than a standalone listing. */
  readonly packageName?: string;
  /** What following the first request's redirect must render. */
  readonly redirect?: PageExpectation;
  /** What the replay, the second request, must render. */
  readonly replay?: PageExpectation;
  readonly session: SessionCase;
};

/** The metadata the case's session carries: its ticket lines as items, signed
 *  at the amount the session totals. */
const sessionMetadata = (
  c: SuccessCase,
  listings: readonly ListingWithCount[],
  pkg: Group | undefined,
) => {
  const fields = {
    email: c.session.email,
    items: JSON.stringify(
      c.lines.map(([listing, price, quantity]) => ({
        e: listings[listing]!.id,
        ...(pkg === undefined ? {} : { k: "p", r: pkg.id }),
        p: price,
        q: quantity,
      })),
    ),
    name: c.session.buyer,
  };
  return c.session.metadata === "webhook"
    ? signedMeta(fields, c.session.amountTotal)
    : signMeta(fields, c.session.amountTotal);
};

/** A payment the success page must render: the single-ticket case, the
 *  concealed package member, and the cart or multi-listing replays. */
/* jscpd:ignore-start -- a table of cases, not code */
const cases: readonly SuccessCase[] = [
  {
    lines: [[0, 500, 1]],
    listings: [
      {
        maxAttendees: 50,
        thankYouUrl: "https://example.com/single-thanks",
        unitPrice: 500,
      },
    ],
    name: "shows thank_you_url for single-ticket success",
    redirect: {
      contains: ["https://example.com/single-thanks", "View your ticket"],
    },
    session: {
      amountTotal: 500,
      buyer: "Single",
      email: "single@example.com",
      metadata: "proof",
      paymentIntent: "pi_single_thankyou",
      sessionId: "cs_single_thankyou",
    },
  },
  {
    lines: [[0, 500, 1]],
    listings: [
      {
        maxAttendees: 50,
        name: "Concealed Member",
        thankYouUrl: "https://example.com/concealed-thanks",
        unitPrice: 500,
      },
    ],
    name: "suppresses thank_you_url for a hidden package's sole member",
    packageName: "Hidden Success Pkg",
    // The ticket link still shows, but the concealed member's thank-you URL
    // (which would meta-refresh to the listing the package hid) must not leak.
    redirect: {
      contains: ["View your ticket"],
      notContains: ["https://example.com/concealed-thanks"],
    },
    session: {
      amountTotal: 500,
      buyer: "Concealed Buyer",
      email: "concealed@example.com",
      metadata: "webhook",
      paymentIntent: "pi_hidden_pkg",
      sessionId: "cs_hidden_pkg",
    },
  },
  {
    lines: [[0, 700, 1]],
    listings: [
      {
        maxAttendees: 50,
        name: "Concealed Replay Member",
        thankYouUrl: "https://example.com/concealed-replay",
        unitPrice: 700,
      },
    ],
    name: "suppresses thank_you_url on replay for a hidden package's sole member",
    packageName: "Hidden Replay Pkg",
    // The replay renders through the single-listing fallback, which must
    // suppress the concealed member's thank-you URL too.
    replay: {
      contains: ["Thank you for your order"],
      notContains: ["https://example.com/concealed-replay"],
    },
    session: {
      amountTotal: 700,
      buyer: "Replay Buyer",
      email: "replay@example.com",
      metadata: "webhook",
      paymentIntent: "pi_hidden_replay",
      sessionId: "cs_hidden_replay",
    },
  },
  {
    lines: [[0, 1000, 1]],
    listings: [
      {
        maxAttendees: 50,
        thankYouUrl: "https://example.com/replay-thanks",
        unitPrice: 1000,
      },
    ],
    name: "handles duplicate session replay (already processed)",
    oneAttendee: true,
    replay: { contains: ["Thank you for your order"] },
    session: {
      amountTotal: 1000,
      buyer: "Dupe",
      email: "dupe@example.com",
      metadata: "proof",
      paymentIntent: "pi_dupe",
      sessionId: "cs_dupe_session",
    },
  },
  {
    lines: [[0, 800, 1]],
    listings: [
      {
        maxAttendees: 50,
        name: "Cart Single",
        thankYouUrl: "https://example.com/cart-thanks",
        unitPrice: 800,
      },
    ],
    name: "handles single-item cart session replay (shows thank_you_url)",
    redirect: { contains: ["redirected"] },
    // A single-item cart replay also shows thank_you_url.
    replay: { contains: ["Thank you for your order", "redirected"] },
    session: {
      amountTotal: 800,
      buyer: "Cart Single Buyer",
      email: "cartsingle@example.com",
      metadata: "proof",
      paymentIntent: "pi_cart_single",
      sessionId: "cs_cart_single",
    },
  },
  {
    lines: [
      [0, 500, 1],
      [1, 1000, 1],
    ],
    listings: [
      { maxAttendees: 50, name: "Replay Multi 1", unitPrice: 500 },
      { maxAttendees: 50, name: "Replay Multi 2", unitPrice: 1000 },
    ],
    name: "handles ticket duplicate session replay (already processed)",
    replay: { contains: ["Thank you for your order"] },
    session: {
      amountTotal: 1500,
      buyer: "Multi Replay",
      email: "multireplay@example.com",
      metadata: "proof",
      paymentIntent: "pi_multi_dupe",
      sessionId: "cs_multi_dupe",
    },
  },
];
/* jscpd:ignore-end */

/** The hidden package a case names, then every listing it sells in it. */
const createCaseListings = async (
  c: SuccessCase,
): Promise<{ listings: ListingWithCount[]; pkg: Group | undefined }> => {
  const pkg =
    c.packageName === undefined
      ? undefined
      : await createHiddenPackageGroup(c.packageName);
  const listings: ListingWithCount[] = [];
  for (const overrides of c.listings) {
    listings.push(
      await createStripeListing({
        ...overrides,
        ...(pkg === undefined ? {} : { groupId: pkg.id }),
      }),
    );
  }
  return { listings, pkg };
};

/** The redirect the first request answers, then the replay it allows. */
const expectCasePages = async (c: SuccessCase, path: string): Promise<void> => {
  // The first request processes the session and answers with the redirect
  // that carries the render tokens.
  const first = await handleRequest(mockRequest(path));
  expect(first.status).toBe(302);
  if (c.redirect !== undefined) {
    await expectHtml(await followRedirect(first, handleRequest), {
      ...c.redirect,
      status: 200,
    });
  }
  // A replay finds the session processed and renders it again without a
  // redirect, so the page must say the same thing.
  if (c.replay !== undefined) {
    await expectHtml(await handleRequest(mockRequest(path)), {
      ...c.replay,
      status: 200,
    });
  }
};

/** Play one case from a stubbed checkout session through to its replay. */
const expectSuccessCase = async (c: SuccessCase): Promise<void> => {
  const { listings, pkg } = await createCaseListings(c);
  using _retrieve = stubRetrieveCheckoutSession({
    amountTotal: c.session.amountTotal,
    metadata: sessionMetadata(c, listings, pkg),
    paymentIntent: c.session.paymentIntent,
    sessionId: c.session.sessionId,
  });
  const path = `/payment/success?session_id=${c.session.sessionId}`;
  await expectCasePages(c, path);
  if (c.oneAttendee === true) {
    // Both requests booked the same payment, so the order stays the one
    // attendee it bought.
    const { getAttendeesRaw } = await import(
      "#test-utils/db-helpers/attendees.ts"
    );
    expect(await getAttendeesRaw(listings[0]!.id)).toHaveLength(1);
  }
};

describeWithEnv("server (payment flow: ticket success)", { db: true }, () => {
  describe("GET /payment/success (ticket)", () => {
    for (const c of cases) {
      test(c.name, () => expectSuccessCase(c));
    }
  });
});
