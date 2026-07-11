/**
 * The address-differences helpers: word-level diffing of the typed address
 * against the chosen one, and rendering the highlighted notice element.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  diffAddressWords,
  renderAddressDiff,
} from "#src/ui/client/admin/address-diff.ts";
import { diffSpec } from "#test-utils/address-lookup-dom.ts";
import { installFakeDom, restoreDocument } from "#test-utils/fake-dom.ts";

describe("diffAddressWords", () => {
  test("marks only the chosen words missing from the typed address", () => {
    expect(
      diffAddressWords("10 Downing Street", "10 Downing Street, LONDON"),
    ).toEqual([
      { changed: false, text: "10 Downing Street," },
      { changed: true, text: "LONDON" },
    ]);
  });

  test("ignores case and punctuation when comparing", () => {
    expect(diffAddressWords("10, downing STREET", "10 Downing Street")).toEqual(
      [{ changed: false, text: "10 Downing Street" }],
    );
  });

  test("groups consecutive changed words into one run", () => {
    expect(diffAddressWords("1 Old Lane", "1 New Long Road")).toEqual([
      { changed: false, text: "1" },
      { changed: true, text: "New Long Road" },
    ]);
  });

  test("everything is changed against an empty typed address", () => {
    expect(diffAddressWords("", "1 Road")).toEqual([
      { changed: true, text: "1 Road" },
    ]);
  });
});

describe("renderAddressDiff", () => {
  afterEach(() => {
    restoreDocument();
  });

  test("shows the heading and marks the differing words", () => {
    const [output] = installFakeDom([diffSpec()]);
    renderAddressDiff("10 Downing Street", "10 Downing Street, LONDON");
    expect(output!.hidden).toBe(false);
    expect(output!.children[0]!.tag).toBe("strong");
    expect(output!.children[0]!.textContent).toBe("Differs: ");
    const marks = output!.children.filter((child) => child.tag === "mark");
    expect(marks.map((mark) => mark.textContent)).toEqual(["LONDON "]);
  });

  test("stays hidden when the chosen address matches the typed one", () => {
    const [output] = installFakeDom([diffSpec()]);
    renderAddressDiff("10 Downing Street", "10 downing street");
    expect(output!.hidden).toBe(true);
  });

  test("stays hidden when nothing was typed before choosing", () => {
    const [output] = installFakeDom([diffSpec()]);
    renderAddressDiff("   ", "10 Downing Street");
    expect(output!.hidden).toBe(true);
  });

  test("does nothing on pages without the notice element", () => {
    installFakeDom([]);
    expect(() => renderAddressDiff("a", "b")).not.toThrow();
  });

  test("a notice missing its heading copy falls back to blank text", () => {
    // The server always renders data-diff-heading; a stripped element still
    // shows the marked words rather than the string "undefined".
    const bare = diffSpec();
    bare.data = { addressDiff: "" };
    const [output] = installFakeDom([bare]);
    renderAddressDiff("1 Old Road", "1 New Road");
    expect(output!.hidden).toBe(false);
    expect(output!.children[0]!.textContent).toBe(" ");
  });
});
