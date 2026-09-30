import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { remainingTickets } from "#booking/remaining-tickets.ts";

describe("booking > remaining tickets", () => {
  test("a fresh line owes its whole quantity", () => {
    expect(remainingTickets({ checked_in: 0, quantity: 3 })).toBe(3);
  });

  test("a partly admitted line owes what it still holds back", () => {
    expect(remainingTickets({ checked_in: 2, quantity: 5 })).toBe(3);
  });

  test("a fully admitted line owes nothing", () => {
    expect(remainingTickets({ checked_in: 4, quantity: 4 })).toBe(0);
  });
});
