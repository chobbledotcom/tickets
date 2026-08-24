import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ProviderTransportError } from "#payment/transport-error.ts";
import { squareAnswer } from "#shared/square/wire.ts";

/** The error every unreadable Square answer raises, whichever answer it was. */
const refusalFrom = (read: () => unknown): ProviderTransportError => {
  let thrown: unknown;
  try {
    read();
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof ProviderTransportError)) {
    throw new Error("Expected the answer to be refused");
  }
  return thrown;
};

/** Prove one answer is refused, and refused as an answer we cannot read. */
const expectRefused = (read: () => unknown): void => {
  const error = refusalFrom(read);
  expect(error.provider).toBe("square");
  expect(error.facts).toEqual({ malformed: true, statusCode: undefined });
};

describe("squareAnswer", () => {
  describe("payment", () => {
    test("reads the fields the money boundary judges a payment by", () => {
      expect(
        squareAnswer.payment({
          payment: {
            amount_money: { amount: 5000, currency: "GBP" },
            id: "pay_1",
            order_id: "ord_1",
            refunded_money: { amount: 1500, currency: "GBP" },
            status: "COMPLETED",
          },
        }),
      ).toEqual({
        payment: {
          amountMoney: { amount: 5000n, currency: "GBP" },
          id: "pay_1",
          orderId: "ord_1",
          refundedMoney: { amount: 1500n, currency: "GBP" },
          status: "COMPLETED",
        },
      });
    });

    // Square leaves the refunded total off a payment nothing has come back on.
    // Absence is the answer, so it stays absent rather than becoming a zero.
    test("keeps absent money absent", () => {
      expect(
        squareAnswer.payment({ payment: { id: "pay_1", status: "PENDING" } }),
      ).toEqual({
        payment: {
          amountMoney: undefined,
          id: "pay_1",
          orderId: undefined,
          refundedMoney: undefined,
          status: "PENDING",
        },
      });
    });

    test("reads an answer carrying no payment as none", () => {
      expect(squareAnswer.payment({})).toEqual({ payment: null });
    });

    for (const [name, payment] of [
      ["no id", { status: "COMPLETED" }],
      ["a blank id", { id: "", status: "COMPLETED" }],
      ["an id with a space in it", { id: "pay 1", status: "COMPLETED" }],
      ["no status", { id: "pay_1" }],
      ["a blank status", { id: "pay_1", status: "" }],
      ["a blank order id", { id: "pay_1", order_id: "", status: "PAID" }],
    ] as const) {
      test(`refuses a payment with ${name}`, () => {
        expectRefused(() => squareAnswer.payment({ payment }));
      });
    }

    for (const [name, money] of [
      ["only a currency", { currency: "GBP" }],
      ["only an amount", { amount: 100 }],
      ["a blank currency", { amount: 100, currency: "" }],
      ["a null amount", { amount: null, currency: "GBP" }],
      ["part of a penny", { amount: 10.5, currency: "GBP" }],
      ["a negative amount", { amount: -100, currency: "GBP" }],
      [
        "an amount past whole-number range",
        { amount: Number.MAX_SAFE_INTEGER + 1, currency: "GBP" },
      ],
    ] as const) {
      test(`refuses money stated as ${name}`, () => {
        expectRefused(() =>
          squareAnswer.payment({
            payment: { amount_money: money, id: "pay_1", status: "COMPLETED" },
          }),
        );
      });
    }
  });

  describe("order", () => {
    test("reads the order facts a checkout session is rebuilt from", () => {
      expect(
        squareAnswer.order({
          order: {
            created_at: "2026-08-24T10:00:00Z",
            id: "ord_1",
            metadata: { name: "Alice" },
            state: "COMPLETED",
            tenders: [
              { id: "t_1", payment_id: "pay_1" },
              { id: "t_2", payment_id: null },
              {},
            ],
            total_money: { amount: 750, currency: "GBP" },
          },
        }),
      ).toEqual({
        order: {
          createdAt: "2026-08-24T10:00:00Z",
          id: "ord_1",
          metadata: { name: "Alice" },
          state: "COMPLETED",
          tenders: [
            { id: "t_1", paymentId: "pay_1" },
            { id: "t_2", paymentId: undefined },
            { id: undefined, paymentId: undefined },
          ],
          totalMoney: { amount: 750n, currency: "GBP" },
        },
      });
    });

    // Nobody has paid yet, so there is no total to read. Null says that, where
    // a zero would say the order is free.
    test("reads an order with no total as a total nobody can read", () => {
      expect(squareAnswer.order({ order: { id: "ord_1" } })).toEqual({
        order: {
          createdAt: undefined,
          id: "ord_1",
          metadata: undefined,
          state: undefined,
          tenders: undefined,
          totalMoney: { amount: null, currency: null },
        },
      });
    });

    test("reads an answer carrying no order as none", () => {
      expect(squareAnswer.order({})).toEqual({ order: null });
    });

    for (const [name, order] of [
      ["no id", { state: "OPEN" }],
      ["a blank id", { id: "" }],
      [
        "a metadata value that is not text",
        { id: "ord_1", metadata: { a: 1 } },
      ],
      ["a metadata value left empty", { id: "ord_1", metadata: { a: null } }],
      ["a tender list that is not a list", { id: "ord_1", tenders: {} }],
      [
        "a total with no currency",
        { id: "ord_1", total_money: { amount: 750 } },
      ],
    ] as const) {
      test(`refuses an order with ${name}`, () => {
        expectRefused(() => squareAnswer.order({ order }));
      });
    }
  });

  describe("paymentLink", () => {
    // Square sends a short and a long address for one checkout page. The long
    // one carries the whole order, so a buyer is sent there.
    test("prefers the long address over the short one", () => {
      expect(
        squareAnswer.paymentLink({
          payment_link: {
            long_url: "https://checkout.square.site/long",
            order_id: "ord_1",
            url: "https://square.link/short",
          },
        }),
      ).toEqual({
        orderId: "ord_1",
        url: "https://checkout.square.site/long",
      });
    });

    test("takes the short address when Square sends only that", () => {
      expect(
        squareAnswer.paymentLink({
          payment_link: { order_id: "ord_1", url: "https://square.link/short" },
        }),
      ).toEqual({ orderId: "ord_1", url: "https://square.link/short" });
    });

    for (const [name, body] of [
      ["names no link at all", {}],
      ["names no order", { payment_link: { url: "https://square.link/s" } }],
      ["names no address", { payment_link: { order_id: "ord_1" } }],
      [
        "leaves the long address blank",
        {
          payment_link: {
            long_url: "",
            order_id: "ord_1",
            url: "https://square.link/s",
          },
        },
      ],
    ] as const) {
      test(`refuses an answer that ${name}`, () => {
        expectRefused(() => squareAnswer.paymentLink(body));
      });
    }
  });

  describe("locations", () => {
    test("reads each place a merchant takes money at", () => {
      expect(
        squareAnswer.locations({
          locations: [{ id: "L_1", name: "Main", status: "ACTIVE" }],
        }),
      ).toEqual({ locations: [{ id: "L_1", name: "Main", status: "ACTIVE" }] });
    });

    test("reads an account with no places as an empty list", () => {
      expect(squareAnswer.locations({})).toEqual({ locations: [] });
    });

    test("refuses a place whose name is not text", () => {
      expectRefused(() => squareAnswer.locations({ locations: [{ name: 7 }] }));
    });
  });

  describe("refund", () => {
    test("reads the refund the engine judges the money by", () => {
      expect(
        squareAnswer.refund({
          refund: {
            amount_money: { amount: 4200, currency: "GBP" },
            id: "ref_1",
            payment_id: "pay_1",
            status: "PENDING",
          },
        }),
      ).toEqual({
        refund: {
          amountMoney: { amount: 4200n, currency: "GBP" },
          id: "ref_1",
          paymentId: "pay_1",
          status: "PENDING",
        },
      });
    });

    for (const [name, body] of [
      ["names no refund", {}],
      [
        "gives the refund no money",
        { refund: { id: "ref_1", payment_id: "pay_1", status: "COMPLETED" } },
      ],
      [
        "names no payment",
        {
          refund: {
            amount_money: { amount: 1, currency: "GBP" },
            id: "ref_1",
            status: "COMPLETED",
          },
        },
      ],
      [
        "uses a status we do not know",
        {
          refund: {
            amount_money: { amount: 1, currency: "GBP" },
            id: "ref_1",
            payment_id: "pay_1",
            status: "APPROVED",
          },
        },
      ],
    ] as const) {
      test(`refuses an answer that ${name}`, () => {
        expectRefused(() => squareAnswer.refund(body));
      });
    }
  });
});
