/**
 * The Logistics-tab extras on the address-lookup client: choosing a located
 * search result fills the lat/lng pin inputs (firing input events for the
 * map) and shows the differences notice when the chosen address changed.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initAddressLookup } from "#src/ui/client/admin/address-lookup.ts";
import {
  diffSpec,
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

  /** A logistics-tab-shaped form: the panel, the textarea, the pin inputs
   * (optionally pre-filled with a saved pin), and the differences notice. */
  const formSpec = (pin: [string, string] = ["", ""]): ElementSpec => ({
    children: [
      panelSpec(),
      { name: "address", tag: "textarea" },
      diffSpec(),
      { name: "lat", tag: "input", type: "text", value: pin[0] },
      { name: "lng", tag: "input", type: "text", value: pin[1] },
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
    let latInputs = 0;
    let lngInputs = 0;
    const { form, lat, lng } = await searchAndChoose(LOCATED);
    // Listen late is fine — re-choose to observe the events.
    lat.addEventListener("input", () => {
      latInputs += 1;
    });
    lng.addEventListener("input", () => {
      lngInputs += 1;
    });
    expect(lat.value).toBe("51.503396");
    expect(lng.value).toBe("-0.127640");
    const select = form.querySelector("[data-address-results]")!;
    select.dispatch("change");
    expect(latInputs).toBe(1);
    expect(lngInputs).toBe(1);
  });

  test("an unlocated address clears a previously saved pin", async () => {
    // A pin left over from the old address must never save against the new
    // one — the operator sets a fresh location instead.
    const { lat, lng } = await searchAndChoose(
      {
        addresses: ["10 Downing Street, LONDON"],
        matches: [{ lat: "", line: "10 Downing Street, LONDON", lng: "" }],
      },
      formSpec(["50.0", "1.0"]),
    );
    expect(lat.value).toBe("");
    expect(lng.value).toBe("");
  });

  test("a response without matches also clears a saved pin", async () => {
    const { lat, lng } = await searchAndChoose(
      { addresses: ["10 Downing Street, LONDON"] },
      formSpec(["50.0", "1.0"]),
    );
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
