/**
 * The Logistics-tab extras on the address-lookup client: choosing a located
 * search result fills the lat/lng pin inputs (firing input events for the
 * map), and the differences notice highlights the chosen words that were not
 * in the typed address.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  diffAddressWords,
  renderAddressDiff,
} from "#src/ui/client/admin/address-diff.ts";
import { initAddressLookup } from "#src/ui/client/admin/address-lookup.ts";
import {
  flushLookup as flush,
  panelSpec,
} from "#test-utils/address-lookup-dom.ts";
import {
  type ElementSpec,
  type FakeElement,
  installFakeDom,
  restoreDocument,
} from "#test-utils/fake-dom.ts";
import { setupFetchStub } from "#test-utils/fetch-stub.ts";

const diffSpec = (): ElementSpec => ({
  data: { addressDiff: "", diffHeading: "Differs:" },
  hidden: true,
  tag: "output",
});

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

describe("address lookup fills the pin inputs", () => {
  const { stubFetch } = setupFetchStub();

  afterEach(() => {
    restoreDocument();
  });

  const LOCATED = {
    addresses: ["10 Downing Street, LONDON"],
    matches: [
      { lat: "51.503396", line: "10 Downing Street, LONDON", lng: "-0.127640" },
    ],
  };

  /** A logistics-tab-shaped form: the panel, the textarea, the pin inputs,
   * and the differences notice. */
  const formSpec = (): ElementSpec => ({
    children: [
      panelSpec(),
      { name: "address", tag: "textarea" },
      diffSpec(),
      { name: "lat", tag: "input", type: "text" },
      { name: "lng", tag: "input", type: "text" },
    ],
    tag: "form",
  });

  /** Install the page, run a search, and choose the first result. `typed`
   * pre-fills the address textarea before searching. */
  const searchAndChoose = async (
    body: unknown,
    page: ElementSpec = formSpec(),
    typed = "",
  ): Promise<{ form: FakeElement; lat: FakeElement; lng: FakeElement }> => {
    stubFetch(() => Promise.resolve(new Response(JSON.stringify(body))));
    const [form] = installFakeDom([page]);
    initAddressLookup();
    const one = (selector: string) => form!.querySelector(selector)!;
    one("textarea").value = typed;
    one("[data-address-search]").value = "SW1A 2AA";
    one("[data-address-find]").dispatch("click");
    await flush();
    const select = one("[data-address-results]");
    select.value = "10 Downing Street, LONDON";
    select.dispatch("change");
    return {
      form: form!,
      lat: one('[name="lat"]'),
      lng: one('[name="lng"]'),
    };
  };

  test("choosing a located address fills lat/lng and fires input events", async () => {
    let inputs = 0;
    const { form, lat, lng } = await searchAndChoose(LOCATED);
    // Listen late is fine — re-choose to observe the events.
    lat.addEventListener("input", () => {
      inputs += 1;
    });
    expect(lat.value).toBe("51.503396");
    expect(lng.value).toBe("-0.127640");
    const select = form.querySelector("[data-address-results]")!;
    select.dispatch("change");
    expect(inputs).toBe(1);
  });

  test("an unlocated address leaves the pin inputs untouched", async () => {
    const { lat, lng } = await searchAndChoose({
      addresses: ["10 Downing Street, LONDON"],
      matches: [{ lat: "", line: "10 Downing Street, LONDON", lng: "" }],
    });
    expect(lat.value).toBe("");
    expect(lng.value).toBe("");
  });

  test("a response without matches leaves the pin inputs untouched", async () => {
    const { lat, lng } = await searchAndChoose({
      addresses: ["10 Downing Street, LONDON"],
    });
    expect(lat.value).toBe("");
    expect(lng.value).toBe("");
  });

  test("a page without pin inputs still fills the textarea", async () => {
    const { form } = await searchAndChoose(LOCATED, {
      children: [panelSpec(), { name: "address", tag: "textarea" }],
      tag: "form",
    });
    expect(form.querySelector("textarea")!.value).toBe(
      "10 Downing Street, LONDON",
    );
  });

  test("choosing a changed address shows the differences notice", async () => {
    const { form } = await searchAndChoose(
      LOCATED,
      formSpec(),
      "10 Downing Street",
    );
    const output = form.querySelector("[data-address-diff]")!;
    expect(output.hidden).toBe(false);
    expect(output.children.filter((child) => child.tag === "mark").length).toBe(
      1,
    );
  });
});
