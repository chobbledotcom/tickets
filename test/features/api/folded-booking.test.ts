import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  applyChildSelectionsToForm,
  parseApiChildSelections,
  processParentApiBooking,
} from "#routes/api/folded-booking.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { FormParams } from "#shared/form-data.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeParent } from "#test-utils/parents.ts";
import { setupStripe } from "#test-utils/settings.ts";

const childCtx = (parentId: number, children: { id: number; slug: string }[]) =>
  ({
    childrenByParentId: new Map([
      [parentId, children.map(({ id, slug }) => ({ listing: { id, slug } }))],
    ]),
  }) as never;

const makeParentListing = async (setup: Parameters<typeof makeParent>[0]) => {
  const { parent, child } = await makeParent(setup);
  const listing = await getListingWithCount(parent.id);
  if (!listing) throw new Error("Expected parent listing");
  return { child, listing, parent };
};

const bookFoldedParent = async (
  setup: Parameters<typeof makeParent>[0],
  body: (childSlug: string) => Record<string, unknown>,
  quantity: number,
) => {
  const parentListing = await makeParentListing(setup);
  const response = await processParentApiBooking(
    new Request("http://localhost/api/book"),
    parentListing.listing,
    body(parentListing.child.slug),
    quantity,
    null,
  );
  return { ...parentListing, response };
};

test("parses child selections and rejects malformed input", () => {
  expect(
    parseApiChildSelections({ children: [{ quantity: 2, slug: "child" }] }),
  ).toEqual([{ quantity: 2, slug: "child" }]);
  expect(parseApiChildSelections({ children: "bad" })).toBeNull();
});

test("sums repeated selections and stores one agreed custom price", () => {
  const form = new FormParams();
  expect(
    applyChildSelectionsToForm(
      form,
      childCtx(1, [{ id: 2, slug: "child" }]),
      1,
      [
        { customPrice: 500, quantity: 1, slug: "child" },
        { customPrice: 500, quantity: 2, slug: "child" },
      ],
    ),
  ).toBeNull();
  expect(form.get("child_qty_1_2")).toBe("3");
  expect(form.get("child_price_1_2")).toBe("500");
});

test("rejects unknown children and conflicting repeated prices", async () => {
  const ctx = childCtx(1, [{ id: 2, slug: "child" }]);
  const unknown = applyChildSelectionsToForm(new FormParams(), ctx, 1, [
    { quantity: 1, slug: "stranger" },
  ]);
  expect(await unknown?.json()).toEqual({
    error: "'stranger' is not a child of this listing.",
  });
  const conflict = applyChildSelectionsToForm(new FormParams(), ctx, 1, [
    { customPrice: 500, quantity: 1, slug: "child" },
    { quantity: 1, slug: "child" },
  ]);
  expect(await conflict?.json()).toEqual({
    error:
      "Conflicting prices for 'child'. Send one entry per child with a single price.",
  });
});

describeWithEnv("folded API booking", { db: true, triggers: true }, () => {
  test("books a free parent and child through the production fold", async () => {
    const { response } = await bookFoldedParent(
      {},
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        email: "buyer@example.com",
        name: "Buyer",
      }),
      1,
    );
    expect(response.status).toBe(200);
  });

  test("records a provider-less paid fold as owed", async () => {
    const { parent, response } = await bookFoldedParent(
      {
        children: [{ maxQuantity: 2, unitPrice: 300 }],
        parent: { maxQuantity: 2, unitPrice: 700 },
      },
      (childSlug) => ({
        children: [{ quantity: 2, slug: childSlug }],
        email: "owed@example.com",
        name: "Owed buyer",
      }),
      2,
    );
    expect(response.status).toBe(200);
    expect((await getAttendeesRaw(parent.id))[0]?.remaining_balance).toBe(2000);
  });

  test("books a free folded order while payments are enabled", async () => {
    await setupStripe();
    const { parent, response } = await bookFoldedParent(
      {},
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        email: "free@example.com",
        name: "Free buyer",
      }),
      1,
    );
    expect(response.status).toBe(200);
    expect((await getAttendeesRaw(parent.id))[0]?.remaining_balance).toBe(0);
  });

  test("starts one paid checkout for the full folded total", async () => {
    await setupStripe();
    let checkoutIntent: unknown;
    using _checkout = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      (intent) => {
        checkoutIntent = intent;
        return Promise.resolve({
          checkoutUrl: "https://pay.example/checkout",
          providerCheckoutId: "provider-folded",
          sessionId: "session-folded",
        });
      },
    );
    const { listing, response } = await bookFoldedParent(
      {
        children: [{ unitPrice: 300 }],
        parent: {
          thankYouUrl: "https://example.com/folded-thanks",
          unitPrice: 700,
        },
      },
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        email: "paid@example.com",
        name: "Paid buyer",
      }),
      1,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      booking: { checkoutUrl: expect.stringContaining("https://") },
    });
    expect(checkoutIntent).toMatchObject({
      items: [
        { quantity: 1, unitPrice: 700 },
        { quantity: 1, unitPrice: 300 },
      ],
      thankYouUrl: listing.thank_you_url,
    });
    expect("dayCount" in (checkoutIntent as Record<string, unknown>)).toBe(
      false,
    );
  });

  test("omits an empty thank-you URL from paid metadata", async () => {
    await setupStripe();
    let checkoutIntent: Record<string, unknown> = {};
    using _checkout = stub(
      stripePaymentProvider,
      "createCheckoutSession",
      (intent) => {
        checkoutIntent = intent as unknown as Record<string, unknown>;
        return Promise.resolve({
          checkoutUrl: "https://pay.example/no-thanks",
          providerCheckoutId: "provider-no-thanks",
          sessionId: "session-no-thanks",
        });
      },
    );
    await bookFoldedParent(
      { parent: { unitPrice: 100 } },
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        email: "a@b.com",
        name: "Buyer",
      }),
      1,
    );
    expect("thankYouUrl" in checkoutIntent).toBe(false);
  });

  test("treats a one-cent folded order as paid", async () => {
    await setupStripe();
    using _checkout = stub(stripePaymentProvider, "createCheckoutSession", () =>
      Promise.resolve({
        checkoutUrl: "https://pay.example/one-cent",
        providerCheckoutId: "provider-one-cent",
        sessionId: "session-one-cent",
      }),
    );
    const { response } = await bookFoldedParent(
      { parent: { unitPrice: 1 } },
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        email: "cent@example.com",
        name: "Cent buyer",
      }),
      1,
    );
    expect(await response.json()).toMatchObject({
      booking: { checkoutUrl: "https://pay.example/one-cent" },
    });
  });

  test("records a provider-less one-cent fold", async () => {
    const { parent } = await bookFoldedParent(
      { parent: { unitPrice: 1 } },
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        email: "owed@example.com",
        name: "Buyer",
      }),
      1,
    );
    expect((await getAttendeesRaw(parent.id))[0]?.remaining_balance).toBe(1);
  });

  test("uses a pay-more parent's submitted price in the owed folded total", async () => {
    const { parent, response } = await bookFoldedParent(
      { parent: { canPayMore: true, maxPrice: 2000, unitPrice: 500 } },
      (childSlug) => ({
        children: [{ quantity: 1, slug: childSlug }],
        customPrice: "15.00",
        email: "custom@example.com",
        name: "Custom buyer",
      }),
      1,
    );
    expect(response.status).toBe(200);
    expect((await getAttendeesRaw(parent.id))[0]?.remaining_balance).toBe(1500);
  });

  test("rejects customisable parents and malformed selections with exact errors", async () => {
    const { listing } = await makeParentListing({});
    expect(
      await (
        await processParentApiBooking(
          new Request("http://localhost/api/book"),
          { ...listing, customisable_days: true },
          {},
          1,
          null,
        )
      ).json(),
    ).toEqual({ error: "This listing must be booked through the website." });

    const ordinary = { ...listing, customisable_days: false };
    expect(
      await (
        await processParentApiBooking(
          new Request("http://localhost/api/book"),
          ordinary,
          { children: "bad" },
          1,
          null,
        )
      ).json(),
    ).toEqual({
      error:
        "Provide a `children` array of { slug, quantity } totalling the booked quantity.",
    });
  });
});
