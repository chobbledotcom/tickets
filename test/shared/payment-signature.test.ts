import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { signPrice, verifyPrice } from "#shared/payment-signature.ts";
import { describeWithEnv } from "#test-utils";

const TOTAL = 4500;

/** A representative logical metadata record (the shape the webhook verifies and
 * the checkout signs). Empty fields use "" — the codebase's "absent" convention. */
const baseMeta = (
  overrides: Record<string, string> = {},
): Record<string, string> => ({
  _origin: "tickets.example.test",
  address: "1 High St",
  answer_ids: "",
  balance_attendee_id: "",
  date: "",
  day_count: "",
  email: "buyer@example.com",
  items: JSON.stringify([{ e: 1, p: 2000, q: 2 }]),
  modifiers: JSON.stringify([{ i: 3, q: 1 }]),
  name: "Buyer",
  phone: "",
  reservation_amount: "",
  site_token_index: "",
  special_instructions: "",
  ...overrides,
});

/** Each signed field paired with a changed value, so tampering any one of them
 * can be checked against an untouched signature. Includes the contact and
 * fulfilment fields (email/phone/site_token_index) that feed pricing or renewal
 * indirectly and so must be bound, not just the obvious price fields. */
const fieldMutations: Array<[string, Record<string, string>]> = [
  ["email", { email: "attacker@example.com" }],
  ["phone", { phone: "07700900000" }],
  ["site_token_index", { site_token_index: "deadbeefcafe" }],
  ["name", { name: "Someone Else" }],
  ["address", { address: "99 Other Rd" }],
  ["special_instructions", { special_instructions: "leave at door" }],
  ["items", { items: JSON.stringify([{ e: 1, p: 1, q: 2 }]) }],
  ["modifiers", { modifiers: JSON.stringify([{ i: 3, q: 2 }]) }],
  ["answer_ids", { answer_ids: JSON.stringify({ "1": [9] }) }],
  ["reservation_amount", { reservation_amount: "10%" }],
  ["balance_attendee_id", { balance_attendee_id: "7" }],
  ["day_count", { day_count: "3" }],
  ["date", { date: "2026-07-01" }],
];

/** Keys deliberately left out of the signed payload — changing them must not
 * invalidate a signature (see the module doc for why each is excluded). */
const excludedKeys: Array<[string, Record<string, string>]> = [
  ["_origin", { _origin: "other-instance.example.test" }],
  ["price_proof", { price_proof: "9999.somedigest" }],
  ["b", { b: '{"phone":"07700900000"}' }],
];

/** Tiny deterministic PRNG so the fuzz loop is repeatable. */
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

describeWithEnv("payment price signature", { encryptionKey: true }, () => {
  test("signing the same metadata and total is deterministic", async () => {
    expect(await signPrice(baseMeta(), TOTAL)).toBe(
      await signPrice(baseMeta(), TOTAL),
    );
  });

  test("a fresh signature verifies", async () => {
    const meta = baseMeta();
    expect(await verifyPrice(meta, TOTAL, await signPrice(meta, TOTAL))).toBe(
      true,
    );
  });

  test("an omitted field and an explicit empty field sign identically", async () => {
    // The checkout builds metadata without empty optionals; the webhook's
    // extracted metadata carries them as "". Both sides must produce the same
    // signature, or every optional-free checkout would fail verification.
    const full = baseMeta();
    const sparse: Record<string, string> = {
      _origin: full._origin!,
      address: full.address!,
      email: full.email!,
      items: full.items!,
      modifiers: full.modifiers!,
      name: full.name!,
    };
    expect(await signPrice(sparse, TOTAL)).toBe(await signPrice(full, TOTAL));
  });

  test("an empty signature never verifies", async () => {
    expect(await verifyPrice(baseMeta(), TOTAL, "")).toBe(false);
  });

  test("a wrong-length signature never verifies", async () => {
    const sig = await signPrice(baseMeta(), TOTAL);
    expect(await verifyPrice(baseMeta(), TOTAL, sig.slice(0, -1))).toBe(false);
  });

  test("a foreign-but-valid-length signature does not verify", async () => {
    // A signature for a different total, same length, must not pass.
    const other = await signPrice(baseMeta(), 9999);
    expect(await verifyPrice(baseMeta(), TOTAL, other)).toBe(false);
  });

  test("tampering the total invalidates the signature", async () => {
    const meta = baseMeta();
    const sig = await signPrice(meta, TOTAL);
    expect(await verifyPrice(meta, TOTAL + 1, sig)).toBe(false);
  });

  for (const [field, override] of fieldMutations) {
    test(`tampering ${field} invalidates the original signature`, async () => {
      const original = await signPrice(baseMeta(), TOTAL);
      const mutated = baseMeta(override);
      expect(await verifyPrice(mutated, TOTAL, original)).toBe(false);
      // The mutated metadata still produces its own valid signature.
      expect(
        await verifyPrice(mutated, TOTAL, await signPrice(mutated, TOTAL)),
      ).toBe(true);
    });
  }

  for (const [key, override] of excludedKeys) {
    test(`changing the unsigned ${key} keeps the signature valid`, async () => {
      const original = await signPrice(baseMeta(), TOTAL);
      expect(await verifyPrice(baseMeta(override), TOTAL, original)).toBe(true);
    });
  }

  test("fuzz: every metadata set round-trips and any single mutation fails", async () => {
    const rand = lcg(20260618);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let i = 0; i < 60; i++) {
      const total = Math.floor(rand() * 100000);
      const meta = baseMeta({
        answer_ids: pick(["", '{"1":[2]}', '{"4":[5,6]}']),
        balance_attendee_id: pick(["", "1", "42"]),
        date: pick(["", "2026-07-01", "2026-12-25"]),
        day_count: pick(["", "2", "5"]),
        email: pick(["a@x.com", "b@y.com"]),
        items: JSON.stringify([
          {
            e: Math.floor(rand() * 5) + 1,
            p: Math.floor(rand() * 10000),
            q: 1,
          },
        ]),
        modifiers: pick(["", '[{"i":1,"q":1}]', '[{"i":2,"q":3}]']),
        phone: pick(["", "07700900000"]),
        reservation_amount: pick(["", "10%", "£5"]),
        site_token_index: pick(["", "abc123"]),
      });
      const sig = await signPrice(meta, total);
      expect(await verifyPrice(meta, total, sig)).toBe(true);
      // Flipping the total by one minor unit must break the signature.
      expect(await verifyPrice(meta, total + 1, sig)).toBe(false);
    }
  });
});
