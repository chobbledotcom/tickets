import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkBookingRateLimit,
  resolveCustomPrice,
  resolvePositiveQuantity,
  toFormParams,
  withActiveListing,
  withApiBody,
  withSlugLoaded,
} from "#routes/api/helpers.ts";
import { FormParams } from "#shared/form-data.ts";
import { MAX_BOOKING_ATTEMPTS } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";

const expectError = async (
  result: unknown,
  status: number,
  error: string,
): Promise<void> => {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
};

describe("resolvePositiveQuantity", () => {
  test("defaults absent and malformed quantities to one", () => {
    expect(resolvePositiveQuantity({})).toBe(1);
    expect(resolvePositiveQuantity({ quantity: "not-a-number" })).toBe(1);
  });

  test("returns a positive quantity", () => {
    expect(resolvePositiveQuantity({ quantity: 3 })).toBe(3);
  });

  test("rejects an explicit zero", async () => {
    await expectError(
      resolvePositiveQuantity({ quantity: 0 }),
      400,
      "Quantity must be at least 1",
    );
  });
});

describeWithEnv("API booking helper inputs", { db: true }, () => {
  test("loads only an active listing and returns the exact missing error", async () => {
    const active = await createTestListing({ name: "Active listing" });
    const inactive = await createTestListing({ name: "Inactive listing" });
    await deactivateTestListing(inactive.id);
    const wrapped = withActiveListing((_request, listing) =>
      Promise.resolve(Response.json({ id: listing.id })),
    );

    const activeResponse = await wrapped(new Request("http://localhost"), {
      slug: active.slug,
    });
    expect(await activeResponse.json()).toEqual({ id: active.id });
    await expectError(
      await wrapped(new Request("http://localhost"), { slug: inactive.slug }),
      404,
      "Listing not found",
    );
    await expectError(
      await wrapped(new Request("http://localhost"), { slug: "missing" }),
      404,
      "Listing not found",
    );
  });

  test("parses a custom price only for a pay-more listing", async () => {
    const fixed = await createTestListing({ unitPrice: 1000 });
    const flexible = await createTestListing({
      canPayMore: true,
      maxPrice: 2000,
      unitPrice: 1000,
    });
    const form = new FormParams({ customPrice: "15.00" });

    expect(resolveCustomPrice(fixed, form)).toBeUndefined();
    expect(resolveCustomPrice(flexible, form)).toBe(1500);
  });

  test("returns the custom-price validation message", async () => {
    const listing = await createTestListing({
      canPayMore: true,
      maxPrice: 2000,
      unitPrice: 1000,
    });
    const result = resolveCustomPrice(
      listing,
      new FormParams({ customPrice: "9.99" }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(await (result as Response).json()).toEqual({
      error: "Price must be at least the minimum ticket price",
    });
  });

  test("records attempts and returns the exact rate-limit response", async () => {
    const request = new Request("http://localhost/api/listings/item/book");
    const server = { requestIP: () => ({ address: "192.0.2.25" }) };

    for (let attempt = 0; attempt < MAX_BOOKING_ATTEMPTS; attempt++) {
      expect(await checkBookingRateLimit(request, server)).toBeNull();
    }
    const limited = await checkBookingRateLimit(request, server);
    expect(limited).toBeInstanceOf(Response);
    expect((limited as Response).status).toBe(429);
    expect(await (limited as Response).json()).toEqual({
      error: "Too many booking attempts. Please try again later.",
    });
  });
});

describe("API helper composition", () => {
  test("passes a valid body to its handler", async () => {
    const response = await withApiBody(
      new Request("http://localhost/api", {
        body: '{"quantity":2}',
        method: "POST",
      }),
      (body) => Promise.resolve(Response.json({ body }, { status: 201 })),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ body: { quantity: 2 } });
  });

  test("passes a loader response through without calling the handler", async () => {
    const failure = Response.json({ error: "Gone" }, { status: 404 });
    let handled = false;
    const wrapped = withSlugLoaded(() => Promise.resolve(failure))(() => {
      handled = true;
      return Promise.resolve(Response.json({ ok: true }));
    });

    expect(
      await wrapped(new Request("http://localhost"), { slug: "gone" }),
    ).toBe(failure);
    expect(handled).toBe(false);
  });

  test("passes the loaded value and server context to the handler", async () => {
    const server = { requestIP: () => ({ address: "127.0.0.1" }) };
    let seenServer: typeof server | undefined;
    const wrapped = withSlugLoaded((slug: string) =>
      Promise.resolve({ slug: `${slug}-loaded` }),
    )((_request, loaded, context) => {
      seenServer = context as typeof server;
      return Promise.resolve(Response.json({ loaded }));
    });

    const response = await wrapped(
      new Request("http://localhost"),
      { slug: "item" },
      server,
    );
    expect(seenServer).toBe(server);
    expect(await response.json()).toEqual({ loaded: { slug: "item-loaded" } });
  });

  test("converts present values to form strings", () => {
    const params = toFormParams({
      count: 2,
      empty: null,
      enabled: false,
      missing: undefined,
    });

    expect([...params.entries()]).toEqual([
      ["count", "2"],
      ["enabled", "false"],
    ]);
  });
});
