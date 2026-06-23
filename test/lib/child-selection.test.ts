import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  childSelectorParentIds,
  onSelectionChange,
  parentInCart,
  selectedListingIds,
} from "#src/ui/client/admin/child-selection.ts";
import {
  childQtySpec as childQty,
  childSelectorSpec as childSelector,
  installFakeDom,
  quantitySpec as quantity,
  restoreDocument,
} from "#test-utils/fake-dom.ts";

describe("child selection helpers", () => {
  afterEach(restoreDocument);

  test("selectedListingIds includes page listings with quantity > 0", () => {
    installFakeDom([
      quantity("101", "2"),
      quantity("102", "0"),
      quantity("103", ""), // blank -> NaN -> treated as 0
    ]);

    expect([...selectedListingIds()].sort()).toEqual(["101"]);
  });

  test("selectedListingIds adds each positive-quantity child of an in-cart parent", () => {
    installFakeDom([
      quantity("101", "2"),
      childSelector("101"),
      childQty("101", "202", "1"),
      childQty("101", "303", "1"),
    ]);

    expect([...selectedListingIds()].sort()).toEqual(["101", "202", "303"]);
  });

  test("selectedListingIds ignores a zero-quantity child of an in-cart parent", () => {
    installFakeDom([
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1"),
      childQty("101", "303", "0"),
    ]);

    expect([...selectedListingIds()].sort()).toEqual(["101", "202"]);
  });

  test("selectedListingIds ignores children whose parent is not in the cart", () => {
    installFakeDom([
      quantity("101", "0"),
      childSelector("101"),
      childQty("101", "202", "1"),
    ]);

    expect([...selectedListingIds()]).toEqual([]);
  });

  test("selectedListingIds ignores a disabled (sold-out) child control", () => {
    installFakeDom([
      quantity("101", "1"),
      childSelector("101"),
      childQty("101", "202", "1", true), // disabled -> never selectable
    ]);

    expect([...selectedListingIds()]).toEqual(["101"]);
  });

  test("parentInCart is false when the parent has no quantity control", () => {
    installFakeDom([childSelector("101")]);

    expect(parentInCart("101")).toBe(false);
    expect(childSelectorParentIds()).toEqual(["101"]);
  });

  test("onSelectionChange fires the listener for quantity and child-quantity changes", () => {
    const roots = installFakeDom([
      quantity("101", "1"),
      childQty("101", "202", "1"),
    ]);
    let calls = 0;

    onSelectionChange(() => {
      calls += 1;
    });
    roots[0]!.dispatch("change");
    roots[1]!.dispatch("change");

    expect(calls).toBe(2);
  });
});
