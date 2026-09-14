import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { countedText, orderLabel, xCount } from "#shared/count-text.ts";

describe("count text", () => {
  test("shows a count as x and the number", () => {
    expect(xCount(1)).toBe("x1");
    expect(xCount(5)).toBe("x5");
  });

  test("wraps a thing and its count in the label every provider order shows", () => {
    expect(countedText("Tickets", 1)).toBe("Tickets (x1)");
    expect(countedText("Summer Festival", 5)).toBe("Summer Festival (x5)");
  });

  test("names the one listing an order stays on, repeated lines included", () => {
    expect(orderLabel(["Summer Festival"], "Tickets")).toBe("Summer Festival");
    // One listing can price into several lines; the name stays one.
    expect(orderLabel(["Summer Festival", "Summer Festival"], "Tickets")).toBe(
      "Summer Festival",
    );
  });

  test("falls back to the mixed label when an order mixes listings or holds none", () => {
    expect(orderLabel(["Workshop", "Gala"], "Tickets")).toBe("Tickets");
    expect(orderLabel([], "Tickets")).toBe("Tickets");
  });
});
