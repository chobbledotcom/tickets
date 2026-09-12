import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ticketsCountText, xCount } from "#shared/count-text.ts";

describe("count text", () => {
  test("shows a count as x and the number", () => {
    expect(xCount(1)).toBe("x1");
    expect(xCount(5)).toBe("x5");
  });

  test("wraps a ticket count in the label every provider order shows", () => {
    expect(ticketsCountText(1)).toBe("Tickets (x1)");
    expect(ticketsCountText(5)).toBe("Tickets (x5)");
  });
});
