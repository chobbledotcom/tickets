import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { SquarePaymentPage } from "#shared/square-client.ts";
import {
  readSquarePaymentPages,
  SQUARE_PAYMENT_PAGE_LIMIT,
} from "#shared/square-payment-pages.ts";

/** One page of Square's payment list, with an optional cursor to the next. */
const page = (ids: string[], cursor?: string) =>
  Promise.resolve({
    status: "found" as const,
    value: {
      payments: ids.map((id) => ({ id })),
      ...(cursor === undefined ? {} : { cursor }),
    } as SquarePaymentPage,
  });

describe("reading only the Square payments we asked for", () => {
  test("asking for nothing reads nothing", async () => {
    const result = await readSquarePaymentPages("L1", new Set(), () => {
      throw new Error("Square must not be asked when nothing is wanted");
    });
    expect(result).toEqual({ payments: new Map() });
  });

  test("stops as soon as the last wanted payment is found", async () => {
    let asked = 0;
    const result = await readSquarePaymentPages("L1", new Set(["p2"]), () => {
      asked += 1;
      return page(["p1", "p2"], "more");
    });
    expect(asked).toBe(1);
    if (!("payments" in result)) throw new Error("Expected payments");
    expect([...result.payments.keys()]).toEqual(["p2"]);
  });

  test("a cursor Square has already given is refused, not followed again", async () => {
    // Following it would ask for the same page forever.
    let asked = 0;
    const result = await readSquarePaymentPages(
      "L1",
      new Set(["never"]),
      () => {
        asked += 1;
        return page([], "same-cursor");
      },
    );
    expect(result).toEqual({ issue: "invalid" });
    expect(asked).toBe(2);
  });

  test("gives up rather than reading Square's whole history", async () => {
    let asked = 0;
    const result = await readSquarePaymentPages(
      "L1",
      new Set(["never"]),
      () => {
        asked += 1;
        return page([], `cursor-${asked}`);
      },
    );
    expect(result).toEqual({ issue: "unavailable" });
    expect(asked).toBe(SQUARE_PAYMENT_PAGE_LIMIT);
  });

  test("a page Square could not give is reported as unavailable", async () => {
    expect(
      await readSquarePaymentPages("L1", new Set(["p1"]), () =>
        Promise.resolve({ status: "unavailable" as const }),
      ),
    ).toEqual({ issue: "unavailable" });
  });

  test("a page Square could not make sense of is reported as invalid", async () => {
    expect(
      await readSquarePaymentPages("L1", new Set(["p1"]), () =>
        Promise.resolve({ status: "missing" as const }),
      ),
    ).toEqual({ issue: "invalid" });
  });
});
