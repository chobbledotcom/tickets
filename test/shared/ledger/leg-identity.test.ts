import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import { legIdentityDiff } from "#shared/ledger/leg-identity.ts";

// A plain LegFacts (the minimal shape legIdentityDiff reads), not a
// full Transfer, so spreads stay within LegFacts and don't trip excess-property
// checks when passed as that type.
const legFacts = {
  amount: 5000,
  destination: account("revenue", 1),
  kind: "sale",
  occurredAt: "2026-01-01T00:00:00.000Z",
  source: account("attendee", 1),
};

describe("legIdentityDiff", () => {
  it("is empty for two legs with identical money facts", () => {
    expect(legIdentityDiff(legFacts, { ...legFacts })).toEqual([]);
  });

  it("names exactly the identity fields that differ, never the matching ones", () => {
    expect(legIdentityDiff(legFacts, { ...legFacts, amount: 1 })).toEqual([
      "amount",
    ]);
    expect(legIdentityDiff(legFacts, { ...legFacts, kind: "fee" })).toEqual([
      "kind",
    ]);
    expect(
      legIdentityDiff(legFacts, {
        ...legFacts,
        source: account("attendee", 2),
      }),
    ).toEqual(["source"]);
    expect(
      legIdentityDiff(legFacts, {
        ...legFacts,
        destination: account("revenue", 2),
      }),
    ).toEqual(["destination"]);
    expect(
      legIdentityDiff(legFacts, {
        ...legFacts,
        occurredAt: "2026-01-02T00:00:00.000Z",
      }),
    ).toEqual(["occurredAt"]);
    expect(legIdentityDiff(legFacts, { ...legFacts, reversesId: 7 })).toEqual([
      "reversesId",
    ]);
    expect(
      legIdentityDiff(legFacts, {
        ...legFacts,
        reversesGroup: "evt-booking",
      }),
    ).toEqual(["reversesGroup"]);
  });

  it("treats a leg with no kind as a leg with an empty kind", () => {
    const { kind: _kind, ...noKind } = legFacts;
    expect(legIdentityDiff(noKind, { ...noKind, kind: "" })).toEqual([]);
    expect(legIdentityDiff(noKind, legFacts)).toEqual(["kind"]);
  });

  it("keeps a reversesId of 0 distinct from an absent link", () => {
    expect(
      legIdentityDiff(
        { ...legFacts, reversesId: 0 },
        { ...legFacts, reversesId: null },
      ),
    ).toEqual(["reversesId"]);
  });

  it("treats a leg with no reverses group as an empty link", () => {
    expect(
      legIdentityDiff(legFacts, { ...legFacts, reversesGroup: "" }),
    ).toEqual([]);
  });
});
