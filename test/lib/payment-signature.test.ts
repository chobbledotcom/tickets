import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type PriceSignatureFields,
  priceFieldsFromMetadata,
  signPrice,
  verifyPrice,
} from "#shared/payment-signature.ts";
import { describeWithEnv } from "#test-utils";

const baseFields = (
  overrides: Partial<PriceSignatureFields> = {},
): PriceSignatureFields => ({
  answerIds: "",
  balanceAttendeeId: "",
  date: "",
  dayCount: "",
  items: JSON.stringify([{ e: 1, p: 2000, q: 2 }]),
  modifiers: JSON.stringify([{ i: 3, q: 1 }]),
  reservationAmount: "",
  total: 4500,
  ...overrides,
});

/** Each price-determining field paired with a different value, so a tamper of
 * any one of them can be checked against an untouched signature. */
const fieldMutations: Array<
  [keyof PriceSignatureFields, PriceSignatureFields]
> = [
  ["total", baseFields({ total: 4501 })],
  ["items", baseFields({ items: JSON.stringify([{ e: 1, p: 1, q: 2 }]) })],
  ["modifiers", baseFields({ modifiers: JSON.stringify([{ i: 3, q: 2 }]) })],
  ["answerIds", baseFields({ answerIds: JSON.stringify({ "1": [9] }) })],
  ["reservationAmount", baseFields({ reservationAmount: "10%" })],
  ["balanceAttendeeId", baseFields({ balanceAttendeeId: "7" })],
  ["dayCount", baseFields({ dayCount: "3" })],
  ["date", baseFields({ date: "2026-07-01" })],
];

/** Tiny deterministic PRNG so the fuzz loop is repeatable. */
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describe("priceFieldsFromMetadata", () => {
  test("maps metadata keys onto the signed field set", () => {
    expect(
      priceFieldsFromMetadata(
        {
          answer_ids: '{"1":[9]}',
          balance_attendee_id: "7",
          date: "2026-07-01",
          day_count: "3",
          items: "ITEMS",
          modifiers: "MODS",
          reservation_amount: "10%",
        },
        4500,
      ),
    ).toEqual({
      answerIds: '{"1":[9]}',
      balanceAttendeeId: "7",
      date: "2026-07-01",
      dayCount: "3",
      items: "ITEMS",
      modifiers: "MODS",
      reservationAmount: "10%",
      total: 4500,
    });
  });

  test("defaults absent fields to empty strings", () => {
    expect(priceFieldsFromMetadata({ items: "ITEMS" }, 0)).toEqual({
      answerIds: "",
      balanceAttendeeId: "",
      date: "",
      dayCount: "",
      items: "ITEMS",
      modifiers: "",
      reservationAmount: "",
      total: 0,
    });
  });
});

describeWithEnv("payment price signature", { encryptionKey: true }, () => {
  test("signing the same fields is deterministic", async () => {
    expect(await signPrice(baseFields())).toBe(await signPrice(baseFields()));
  });

  test("a fresh signature verifies", async () => {
    const fields = baseFields();
    expect(await verifyPrice(fields, await signPrice(fields))).toBe(true);
  });

  test("an empty signature never verifies", async () => {
    expect(await verifyPrice(baseFields(), "")).toBe(false);
  });

  test("a wrong-length signature never verifies", async () => {
    const sig = await signPrice(baseFields());
    expect(await verifyPrice(baseFields(), sig.slice(0, -1))).toBe(false);
  });

  test("a foreign-but-valid-length signature does not verify", async () => {
    // A signature for different fields, same length, must not pass.
    const other = await signPrice(baseFields({ total: 9999 }));
    expect(await verifyPrice(baseFields(), other)).toBe(false);
  });

  for (const [field, mutated] of fieldMutations) {
    test(`tampering ${field} invalidates the original signature`, async () => {
      const original = await signPrice(baseFields());
      expect(await verifyPrice(mutated, original)).toBe(false);
      // The mutated fields still produce their own valid signature.
      expect(await verifyPrice(mutated, await signPrice(mutated))).toBe(true);
    });
  }

  test("fuzz: every field set round-trips and any single mutation fails", async () => {
    const rand = lcg(20260618);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let i = 0; i < 60; i++) {
      const fields = baseFields({
        answerIds: pick(["", '{"1":[2]}', '{"4":[5,6]}']),
        balanceAttendeeId: pick(["", "1", "42"]),
        date: pick(["", "2026-07-01", "2026-12-25"]),
        dayCount: pick(["", "2", "5"]),
        items: JSON.stringify([
          {
            e: Math.floor(rand() * 5) + 1,
            p: Math.floor(rand() * 10000),
            q: 1,
          },
        ]),
        modifiers: pick(["", '[{"i":1,"q":1}]', '[{"i":2,"q":3}]']),
        reservationAmount: pick(["", "10%", "£5"]),
        total: Math.floor(rand() * 100000),
      });
      const sig = await signPrice(fields);
      expect(await verifyPrice(fields, sig)).toBe(true);
      // Flipping the total by one minor unit must break the signature.
      expect(
        await verifyPrice({ ...fields, total: fields.total + 1 }, sig),
      ).toBe(false);
    }
  });
});
