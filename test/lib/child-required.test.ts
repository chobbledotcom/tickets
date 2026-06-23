import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initChildRequired } from "#src/ui/client/admin/child-required.ts";
import {
  childSelectorSpec as childSelector,
  type FakeElement,
  installFakeDom,
  childPriceSpec as priceInput,
  quantitySpec as quantity,
  childRadioSpec as radio,
  restoreDocument,
} from "#test-utils/fake-dom.ts";

const byName = (roots: FakeElement[], name: string): FakeElement =>
  roots.find((root) => root.attrs.get("name") === name)!;

describe("child required toggling", () => {
  afterEach(restoreDocument);

  test("does nothing when there is no child selector on the page", () => {
    installFakeDom([quantity("101", "1")]);
    // No throw, no listener wiring needed.
    expect(() => initChildRequired()).not.toThrow();
  });

  test("requires the radio group and only the selected pay-more child's price for an in-cart parent", () => {
    const roots = installFakeDom([
      quantity("101", "2"),
      childSelector("101"),
      radio("101", "202", true),
      radio("101", "303", false),
      priceInput("101", "202"),
      priceInput("101", "303"),
    ]);

    initChildRequired();

    expect(byName(roots, "child_101").required).toBe(true);
    expect(byName(roots, "child_price_101_202").required).toBe(true);
    expect(byName(roots, "child_price_101_303").required).toBe(false);
  });

  test("relaxes all child controls when the parent is at zero quantity", () => {
    const roots = installFakeDom([
      quantity("101", "0"),
      childSelector("101"),
      radio("101", "202", true),
      priceInput("101", "202"),
    ]);

    initChildRequired();

    expect(byName(roots, "child_101").required).toBe(false);
    expect(byName(roots, "child_price_101_202").required).toBe(false);
  });

  test("re-requires the new price input when the buyer switches child", () => {
    const roots = installFakeDom([
      quantity("101", "1"),
      childSelector("101"),
      radio("101", "202", true),
      radio("101", "303", false),
      priceInput("101", "202"),
      priceInput("101", "303"),
    ]);

    initChildRequired();
    expect(byName(roots, "child_price_101_202").required).toBe(true);
    expect(byName(roots, "child_price_101_303").required).toBe(false);

    const first = byName(roots, "child_101"); // 202 radio (first match)
    const second = roots[3]!; // 303 radio
    first.checked = false;
    second.checked = true;
    second.dispatch("change");

    expect(byName(roots, "child_price_101_202").required).toBe(false);
    expect(byName(roots, "child_price_101_303").required).toBe(true);
  });

  test("requires no price input when an in-cart parent has no child checked", () => {
    const roots = installFakeDom([
      quantity("101", "1"),
      childSelector("101"),
      radio("101", "202", false),
      priceInput("101", "202"),
    ]);

    initChildRequired();

    // Radio group is still required (a choice must be made) but no price is.
    expect(byName(roots, "child_101").required).toBe(true);
    expect(byName(roots, "child_price_101_202").required).toBe(false);
  });
});
