/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  installFakeDom,
  restoreDocument,
  soleChildSpec,
} from "#test-utils/fake-dom.ts";

/** Direct coverage for the fake-DOM selector parser and element model that the
 *  client-script tests exercise only incidentally. Main brought
 *  `test/test-utils/` into the coverage scope (#1448), so the branches no
 *  client-script test happens to drive — a `:checked` clause, a data-attribute
 *  value mismatch, a no-listener dispatch, the default tag, a sole child's
 *  `compat.spans` — get a direct test here rather than rely on incidental
 *  coverage. */
describe("fake-dom", () => {
  afterEach(restoreDocument);

  test("a :checked clause matches a checked element and misses an unchecked one", () => {
    installFakeDom([
      { checked: true, name: "agree", tag: "input" },
      { checked: false, name: "disagree", tag: "input" },
    ]);
    expect(
      document.querySelector('input[name="agree"]:checked'),
    ).not.toBeNull();
    expect(document.querySelector('input[name="disagree"]:checked')).toBeNull();
  });

  test("a data-attribute value mismatch excludes the element from the result set", () => {
    // Two elements carry data-sole-parent; only the one whose value equals the
    // selector's quoted value matches. The other hits the dataValue-mismatch
    // branch (has the key, wrong value) and is filtered out.
    installFakeDom([
      { data: { soleParent: "101" }, tag: "p" },
      { data: { soleParent: "202" }, tag: "p" },
    ]);
    const matches = document.querySelectorAll('[data-sole-parent="202"]');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.getAttribute("data-sole-parent")).toBe("202");
  });

  test("dispatching an event with no registered listeners is a no-op", () => {
    const el = installFakeDom([{ name: "date", tag: "select" }])[0]!;
    let called = 0;
    el.addEventListener("change", () => {
      called++;
    });
    el.dispatch("change");
    expect(called).toBe(1);
    // A second event type with no listeners falls through the ?? [] empty
    // list without invoking the change listener.
    el.dispatch("blur");
    expect(called).toBe(1);
  });

  test("an element spec without a tag defaults to input", () => {
    const el = installFakeDom([{ name: "free_text" }])[0]!;
    expect(el.tag).toBe("input");
  });

  test("a sole-child spec carries its supported spans as data-child-spans", () => {
    installFakeDom([soleChildSpec("101", "202", { spans: [1, 2] })]);
    const marker = document.querySelector('[data-sole-child="202"]');
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute("data-child-spans")).toBe("1,2");
  });
});
