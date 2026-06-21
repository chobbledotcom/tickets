import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import type { LedgerError, TransferInput } from "#shared/ledger/types.ts";
import { validateTransfer } from "#shared/ledger/validate.ts";

const base: TransferInput = {
  amount: 1000,
  currency: "GBP",
  destination: account("revenue", 1),
  eventGroup: "evt",
  occurredAt: "2026-01-01T00:00:00.000Z",
  reference: "ref",
  source: account("attendee", 1),
};

const cases: [
  name: string,
  patch: Partial<TransferInput>,
  code: LedgerError["code"],
][] = [
  ["zero amount", { amount: 0 }, "non_positive_amount"],
  ["negative amount", { amount: -1 }, "non_positive_amount"],
  ["fractional amount", { amount: 10.5 }, "non_integer_amount"],
  ["unsafe (too large) amount", { amount: 2 ** 53 }, "unsafe_amount"],
  ["empty occurred-at", { occurredAt: "" }, "invalid_occurred_at"],
  ["non-ISO occurred-at", { occurredAt: "21/06/2026" }, "invalid_occurred_at"],
  [
    "impossible ISO occurred-at",
    { occurredAt: "2026-13-99T00:00:00Z" },
    "invalid_occurred_at",
  ],
  [
    "overflow ISO occurred-at (Feb 30 normalises away)",
    { occurredAt: "2026-02-30T00:00:00.000Z" },
    "invalid_occurred_at",
  ],
  [
    "non-canonical precision occurred-at (no milliseconds)",
    { occurredAt: "2026-01-01T00:00:00Z" },
    "invalid_occurred_at",
  ],
  ["self transfer", { destination: account("attendee", 1) }, "self_transfer"],
  ["empty source type", { source: { id: "1", type: "" } }, "empty_account"],
  [
    "empty destination id",
    { destination: { id: "", type: "revenue" } },
    "empty_account",
  ],
  [
    "reserved char in account",
    { source: account("attendee", "1\u00002") },
    "reserved_char_in_account",
  ],
  ["empty currency", { currency: "" }, "empty_currency"],
  ["empty reference", { reference: "" }, "empty_reference"],
  ["empty event group", { eventGroup: "" }, "empty_event_group"],
];

describe("validateTransfer", () => {
  it("accepts a well-formed transfer and returns the value", () => {
    expect(validateTransfer(base)).toEqual({ ok: true, value: base });
  });

  for (const [name, patch, code] of cases) {
    it(`rejects ${name} with ${code}`, () => {
      const result = validateTransfer({ ...base, ...patch });
      if (result.ok) throw new Error("expected validation to fail");
      expect(result.errors).toContainEqual({ code });
    });
  }

  it("reports every problem at once, not just the first", () => {
    const result = validateTransfer({
      ...base,
      amount: 0,
      currency: "",
      destination: account("attendee", 1),
    });
    if (result.ok) throw new Error("expected validation to fail");
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain("non_positive_amount");
    expect(codes).toContain("self_transfer");
    expect(codes).toContain("empty_currency");
  });
});
