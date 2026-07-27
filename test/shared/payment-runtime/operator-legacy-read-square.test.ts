import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { squareApi } from "#shared/square.ts";
import type { SquarePayment } from "#shared/square-payments.ts";
import {
  account,
  legacyPayment,
  read,
  squarePayment,
} from "#test/shared/payment-runtime/operator-legacy-read-fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const stubFoundSquarePayment = (
  changes: Partial<SquarePayment> = {},
  sandbox = true,
) => {
  settings.setForTest({
    square_access_token: "square-token",
    square_location_id: "location-one",
    square_sandbox: sandbox,
  });
  return stub(squareApi, "readPayment", (reference) =>
    Promise.resolve({
      status: "found" as const,
      value: squarePayment(reference, changes),
    }),
  );
};

describeWithEnv("legacy Square payment reads", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  for (const result of [
    { expected: { status: "missing" }, value: { status: "missing" } },
    {
      expected: { status: "ambiguous" },
      value: { reason: "mismatched_id", status: "invalid" },
    },
  ] as const) {
    test(`maps a Square ${result.value.status} read`, async () => {
      settings.setForTest({
        square_access_token: "square-token",
        square_location_id: "location-one",
        square_sandbox: true,
      });
      using _provider = stub(squareApi, "readPayment", () =>
        Promise.resolve(result.value),
      );

      expect(
        await read(await legacyPayment("square-read"), account("square")),
      ).toEqual(result.expected);
    });
  }

  test("surfaces an unavailable Square read", async () => {
    using _provider = stub(squareApi, "readPayment", () =>
      Promise.resolve({ status: "unavailable" as const }),
    );
    await expect(
      read(await legacyPayment("square-read"), account("square")),
    ).rejects.toThrow("Square could not check the older payment");
  });

  const invalidSquarePayments: ReadonlyArray<{
    accountMode?: "live" | "test";
    changes: Partial<SquarePayment>;
    name: string;
  }> = [
    { changes: { id: "other" }, name: "id" },
    { changes: { status: "APPROVED" }, name: "status" },
    { changes: { locationId: "other" }, name: "location" },
    { changes: { amountMoney: undefined }, name: "amount" },
    {
      changes: { amountMoney: { amount: BigInt(0), currency: "GBP" } },
      name: "positive amount",
    },
    {
      changes: {
        amountMoney: {
          amount: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
          currency: "GBP",
        },
      },
      name: "safe amount",
    },
    {
      changes: { amountMoney: { amount: BigInt(1_000) } },
      name: "currency",
    },
    {
      changes: { refundedMoney: { amount: BigInt(-1), currency: "GBP" } },
      name: "non-negative refund",
    },
    {
      changes: { refundedMoney: { currency: "GBP" } },
      name: "refund amount",
    },
    {
      changes: { refundedMoney: { amount: BigInt(1_001), currency: "GBP" } },
      name: "refund total",
    },
    {
      changes: { refundedMoney: { amount: BigInt(1), currency: "EUR" } },
      name: "refund currency",
    },
    { accountMode: "live", changes: {}, name: "mode" },
  ];

  for (const example of invalidSquarePayments) {
    test(`rejects a Square payment with the wrong ${example.name}`, async () => {
      using _provider = stubFoundSquarePayment(example.changes);

      expect(
        await read(
          await legacyPayment("square-read"),
          account("square", example.accountMode),
        ),
      ).toEqual({ status: "ambiguous" });
    });
  }

  test("keeps exact Square money when no order can attach it", async () => {
    using _provider = stubFoundSquarePayment({
      orderId: undefined,
      refundedMoney: { amount: BigInt(200), currency: "GBP" },
    });

    expect(
      await read(await legacyPayment("square-read"), account("square")),
    ).toEqual({
      captured: { amount: 1_000, currency: "GBP" },
      refunded: { amount: 200, currency: "GBP" },
      status: "reviewed",
    });
  });

  test("attaches an exact Square charge and order", async () => {
    using _provider = stubFoundSquarePayment();

    expect(
      await read(await legacyPayment("square-read"), account("square")),
    ).toEqual({
      captured: { amount: 1_000, currency: "GBP" },
      charge: {
        id: "square-read",
        kind: "square_payment",
        parentId: "square-order",
        provider: "square",
      },
      refunded: { amount: 0, currency: "GBP" },
      session: {
        id: "square-order",
        kind: "square_order",
        provider: "square",
      },
      status: "attached",
    });
  });

  test("reads an exact live Square payment", async () => {
    using _provider = stubFoundSquarePayment({}, false);

    expect(
      await read(await legacyPayment("square-live"), account("square", "live")),
    ).toMatchObject({ status: "attached" });
  });
});
