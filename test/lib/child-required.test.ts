import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initChildRequired } from "#src/ui/client/admin/child-required.ts";
import {
  childSelectorSpec as childSelector,
  type FakeElement,
  childHintSpec as hint,
  installFakeDom,
  childPriceSpec as priceInput,
  childQtySpec as qty,
  quantitySpec as quantity,
  restoreDocument,
  soleChildSpec as soleChild,
} from "#test-utils/fake-dom.ts";

const byName = (roots: FakeElement[], name: string): FakeElement =>
  roots.find((root) => root.attrs.get("name") === name)!;

const byHint = (roots: FakeElement[], parentId: string): FakeElement =>
  roots.find((root) => root.dataset.childHint === parentId)!;

describe("child required toggling", () => {
  afterEach(restoreDocument);

  test("does nothing when there is no child selector on the page", () => {
    installFakeDom([quantity("101", "1")]);
    // No throw, no listener wiring needed.
    expect(() => initChildRequired()).not.toThrow();
  });

  test("requires only the price inputs of children with a positive quantity for an in-cart parent", () => {
    const roots = installFakeDom([
      quantity("101", "2"),
      childSelector("101"),
      qty("101", "202", "2"),
      qty("101", "303", "0"),
      priceInput("101", "202"),
      priceInput("101", "303"),
    ]);

    initChildRequired();

    // The chosen child's (202) price is required; the unselected sibling's is not.
    expect(byName(roots, "child_price_101_202").required).toBe(true);
    expect(byName(roots, "child_price_101_303").required).toBe(false);
  });

  test("relaxes all child price controls when the parent is at zero quantity", () => {
    const roots = installFakeDom([
      quantity("101", "0"),
      childSelector("101"),
      qty("101", "202", "2"),
      priceInput("101", "202"),
    ]);

    initChildRequired();

    expect(byName(roots, "child_price_101_202").required).toBe(false);
  });

  test("re-requires the new price input when the buyer redistributes the quantities", () => {
    const roots = installFakeDom([
      quantity("101", "2"),
      childSelector("101"),
      qty("101", "202", "2"),
      qty("101", "303", "0"),
      priceInput("101", "202"),
      priceInput("101", "303"),
    ]);

    initChildRequired();
    expect(byName(roots, "child_price_101_202").required).toBe(true);
    expect(byName(roots, "child_price_101_303").required).toBe(false);

    // Move one unit from 202 to 303 (still totalling 2).
    const first = byName(roots, "child_qty_101_202");
    const second = byName(roots, "child_qty_101_303");
    first.value = "1";
    second.value = "1";
    second.dispatch("change");

    expect(byName(roots, "child_price_101_202").required).toBe(true);
    expect(byName(roots, "child_price_101_303").required).toBe(true);
  });

  test("requires no price input when an in-cart parent has no child chosen", () => {
    const roots = installFakeDom([
      quantity("101", "1"),
      childSelector("101"),
      qty("101", "202", "0"),
      priceInput("101", "202"),
    ]);

    initChildRequired();

    expect(byName(roots, "child_price_101_202").required).toBe(false);
  });

  test("shows a live 'X of Q chosen' hint for an in-cart parent", () => {
    const roots = installFakeDom([
      quantity("101", "3"),
      childSelector("101"),
      qty("101", "202", "1"),
      qty("101", "303", "1"),
      hint("101"),
    ]);

    initChildRequired();
    // 2 of the parent's 3 add-ons chosen so far.
    expect(byHint(roots, "101").textContent).toBe("2 / 3");

    // Choosing the third add-on completes the total.
    byName(roots, "child_qty_101_303").value = "2";
    byName(roots, "child_qty_101_303").dispatch("change");
    expect(byHint(roots, "101").textContent).toBe("3 / 3");
  });

  test("requires a sole auto-selected pay-more child's price when the parent is in the cart (Fix 2)", () => {
    // A sole bookable child renders informational (no `child_qty_*` control), so
    // `chosenChildIds` never reports it. Its pay-more price input is still
    // collected and the server fold rejects a blank one, so it must be required
    // whenever the parent is in the cart.
    const roots = installFakeDom([
      quantity("101", "2"),
      childSelector("101"),
      soleChild("101", "202"),
      priceInput("101", "202"),
    ]);

    initChildRequired();

    expect(byName(roots, "child_price_101_202").required).toBe(true);
  });

  test("does not require a sole pay-more child's price when the parent is at zero quantity (Fix 2)", () => {
    const roots = installFakeDom([
      quantity("101", "0"),
      childSelector("101"),
      soleChild("101", "202"),
      priceInput("101", "202"),
    ]);

    initChildRequired();

    expect(byName(roots, "child_price_101_202").required).toBe(false);
  });

  test("blanks the hint when the parent is at zero quantity", () => {
    const roots = installFakeDom([
      quantity("101", "0"),
      childSelector("101"),
      qty("101", "202", "0"),
      hint("101"),
    ]);

    initChildRequired();
    expect(byHint(roots, "101").textContent).toBe("");
  });
});
