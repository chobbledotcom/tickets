import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account, accountKey, sameAccount } from "#shared/ledger/account.ts";

describe("account", () => {
  it("stringifies a numeric id", () => {
    expect(account("revenue", 42)).toEqual({ id: "42", type: "revenue" });
  });

  it("preserves a string id", () => {
    expect(account("psp", "stripe")).toEqual({ id: "stripe", type: "psp" });
  });
});

describe("accountKey", () => {
  it("is equal for equal accounts", () => {
    expect(accountKey(account("revenue", 1))).toBe(
      accountKey(account("revenue", 1)),
    );
  });

  it("differs for accounts that differ only by id", () => {
    expect(accountKey(account("revenue", 1))).not.toBe(
      accountKey(account("revenue", 2)),
    );
  });

  it("does not collide when a part contains a space", () => {
    // A space separator would map both of these to "a b c"; the NUL separator
    // keeps them distinct.
    expect(accountKey({ id: "b c", type: "a" })).not.toBe(
      accountKey({ id: "c", type: "a b" }),
    );
  });
});

describe("sameAccount", () => {
  it("is true for structurally equal refs", () => {
    expect(sameAccount(account("revenue", 1), account("revenue", 1))).toBe(
      true,
    );
  });

  it("is false when the type differs", () => {
    expect(sameAccount(account("revenue", 1), account("attendee", 1))).toBe(
      false,
    );
  });

  it("is false when the id differs", () => {
    expect(sameAccount(account("revenue", 1), account("revenue", 2))).toBe(
      false,
    );
  });
});
