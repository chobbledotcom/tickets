import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ALL_LEDGER_SCOPE,
  type LedgerScope,
  ledgerScopeSelected,
  listingIdsForLedgerScope,
  resolveLedgerScope,
  setLedgerScopeParam,
} from "#shared/ledger-scope.ts";

const listing: LedgerScope = { id: 1, kind: "listing", name: "Concert" };
const group: LedgerScope = { id: 2, kind: "group", name: "Weekend" };
const options = {
  groups: [{ id: 2, name: "Weekend" }],
  listings: [{ id: 1, name: "Concert" }],
};

describe("ledger scope", () => {
  test("resolves URL scope with listing precedence and group fallback", () => {
    const resolve = (query: string) =>
      resolveLedgerScope(
        new URLSearchParams(query),
        options.listings,
        options.groups,
      );

    expect(resolve("listing=1&group=2")).toEqual(listing);
    expect(resolve("listing=999&group=2")).toEqual(group);
    expect(resolve("listing=bad&group=999")).toEqual(ALL_LEDGER_SCOPE);
    expect(resolve("")).toEqual(ALL_LEDGER_SCOPE);
  });

  test("writes exactly one scope parameter", () => {
    const write = (scope: LedgerScope): string => {
      const params = new URLSearchParams("from=2026-06-01&listing=9&group=8");
      setLedgerScopeParam(params, scope);
      return params.toString();
    };

    expect(write(ALL_LEDGER_SCOPE)).toBe("from=2026-06-01");
    expect(write(listing)).toBe("from=2026-06-01&listing=1");
    expect(write(group)).toBe("from=2026-06-01&group=2");
  });

  test("maps each scope to its visible listing ids", () => {
    expect(listingIdsForLedgerScope(ALL_LEDGER_SCOPE, [3, 4])).toBeNull();
    expect(listingIdsForLedgerScope(listing, [3, 4])).toEqual([1]);
    expect(listingIdsForLedgerScope(group, [3, 4])).toEqual([3, 4]);
    expect(listingIdsForLedgerScope(group, [])).toEqual([]);
  });

  test("selects only an option with the same scope kind and id", () => {
    expect(ledgerScopeSelected(ALL_LEDGER_SCOPE, ALL_LEDGER_SCOPE)).toBe(true);
    expect(ledgerScopeSelected(listing, listing)).toBe(true);
    expect(ledgerScopeSelected(group, group)).toBe(true);
    expect(ledgerScopeSelected(group, listing)).toBe(false);
    expect(ledgerScopeSelected(listing, group)).toBe(false);
    expect(ledgerScopeSelected(listing, ALL_LEDGER_SCOPE)).toBe(false);
  });
});
