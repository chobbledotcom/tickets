/**
 * The offline page's fake elements: the contract the page's own journeys
 * lean on. The journeys pin what the page does; this suite pins the fake
 * where no journey reaches it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fakeElement } from "./page-fakes.ts";

describe("the fake element's attributes", () => {
  test("an attribute the page never set reads as null, as the DOM reads it", () => {
    const el = fakeElement("scanner-offline-toggle");
    expect(el.getAttribute("aria-pressed")).toBe(null);
  });
});
