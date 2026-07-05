/**
 * Address-lookup client enhancement: reveals the server-rendered panel,
 * searches the endpoint, fills the select, copies the chosen line into the
 * textarea, and manages the locked/editable textarea modes.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initAddressLookup } from "#src/ui/client/admin/address-lookup.ts";
import {
  type ElementSpec,
  type FakeElement,
  installFakeDom,
  restoreDocument,
} from "#test-utils/fake-dom.ts";
import { setupFetchStub } from "#test-utils/fetch-stub.ts";

const panelSpec = (mode: "locked" | "editable"): ElementSpec => ({
  children: [
    {
      children: [{ data: { addressSearch: "" }, tag: "input", type: "text" }],
      tag: "label",
    },
    { data: { addressFind: "" }, tag: "button" },
    {
      children: [{ data: { addressResults: "" }, tag: "select" }],
      data: { addressResultsLabel: "" },
      hidden: true,
      tag: "label",
    },
    { data: { addressStatus: "" }, hidden: true, tag: "p" },
    ...(mode === "locked"
      ? [{ data: { addressEdit: "" }, hidden: true, tag: "button" }]
      : []),
  ],
  data: {
    addressLookup: mode,
    error: "Lookup failed",
    noResults: "No addresses found",
    placeholder: "Select an address…",
    searching: "Searching…",
  },
  hidden: true,
  tag: "div",
});

const formSpec = (mode: "locked" | "editable"): ElementSpec => ({
  children: [panelSpec(mode), { name: "address", tag: "textarea" }],
  tag: "form",
});

type Parts = {
  form: FakeElement;
  panel: FakeElement;
  searchInput: FakeElement;
  findButton: FakeElement;
  resultsLabel: FakeElement;
  select: FakeElement;
  status: FakeElement;
  editButton: FakeElement | null;
  textarea: FakeElement;
};

/** Install the DOM, run the enhancement, and hand back the pieces. */
const setup = (mode: "locked" | "editable"): Parts => {
  const [form] = installFakeDom([formSpec(mode)]);
  initAddressLookup();
  const one = (selector: string) => form!.querySelector(selector)!;
  return {
    editButton: form!.querySelector("[data-address-edit]"),
    findButton: one("[data-address-find]"),
    form: form!,
    panel: one("[data-address-lookup]"),
    resultsLabel: one("[data-address-results-label]"),
    searchInput: one("[data-address-search]"),
    select: one("[data-address-results]"),
    status: one("[data-address-status]"),
    textarea: one("textarea"),
  };
};

/** Let the async search settle (fetch → json → DOM writes). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe("address lookup client", () => {
  const { callCount, stubFetch } = setupFetchStub();

  afterEach(() => {
    restoreDocument();
  });

  test("a select without its results-label wrapper stays disabled", () => {
    // The select alone isn't enough — revealing it needs the label to unhide.
    const partial = panelSpec("locked");
    partial.children = partial.children!.map((c) =>
      "addressResultsLabel" in (c.data ?? {})
        ? { data: { addressResults: "" }, tag: "select" as const }
        : c,
    );
    const [form] = installFakeDom([
      {
        children: [partial, { name: "address", tag: "textarea" }],
        tag: "form",
      },
    ]);
    initAddressLookup();
    expect(form!.querySelector("[data-address-lookup]")!.hidden).toBe(true);
  });

  test("does nothing on a page without a panel", () => {
    const [textarea] = installFakeDom([{ name: "address", tag: "textarea" }]);
    expect(() => initAddressLookup()).not.toThrow();
    expect(textarea!.readOnly).toBe(false);
  });

  test("leaves the panel hidden when the address textarea is missing", () => {
    const [panel] = installFakeDom([panelSpec("locked")]);
    initAddressLookup();
    expect(panel!.hidden).toBe(true);
  });

  test("leaves a panel missing its own controls hidden", () => {
    const gutted = { ...panelSpec("locked"), children: [] };
    const [form] = installFakeDom([
      { children: [gutted, { name: "address", tag: "textarea" }], tag: "form" },
    ]);
    initAddressLookup();
    expect(form!.querySelector("[data-address-lookup]")!.hidden).toBe(true);
  });

  // Any single absent control disables the whole panel — a partial panel
  // must never be revealed half-wired.
  for (const missing of [
    "addressSearch",
    "addressFind",
    "addressResultsLabel",
    "addressResults",
    "addressStatus",
  ]) {
    test(`leaves a panel missing its ${missing} control hidden`, () => {
      const hasControl = (spec: ElementSpec): boolean =>
        missing in (spec.data ?? {}) ||
        (spec.children ?? []).some(hasControl);
      const partial = panelSpec("locked");
      partial.children = partial.children!.filter((c) => !hasControl(c));
      const [form] = installFakeDom([
        {
          children: [partial, { name: "address", tag: "textarea" }],
          tag: "form",
        },
      ]);
      initAddressLookup();
      expect(form!.querySelector("[data-address-lookup]")!.hidden).toBe(true);
    });
  }

  test("locked mode without an Edit button never locks the textarea", () => {
    // The server always renders the Edit button in locked mode; if it is
    // missing, locking would trap the user, so the textarea stays editable.
    const noEdit = panelSpec("locked");
    noEdit.children = noEdit.children!.filter(
      (c) => !("addressEdit" in (c.data ?? {})),
    );
    const [form] = installFakeDom([
      { children: [noEdit, { name: "address", tag: "textarea" }], tag: "form" },
    ]);
    initAddressLookup();
    expect(form!.querySelector("textarea")!.readOnly).toBe(false);
  });

  test("a locked textarea outside any form still locks and unlocks", () => {
    const [, textarea] = installFakeDom([
      panelSpec("locked"),
      { name: "address", tag: "textarea" },
    ]);
    initAddressLookup();
    expect(textarea!.readOnly).toBe(true);
  });

  test("locked mode reveals the panel, locks the textarea, shows Edit", () => {
    const { editButton, panel, textarea } = setup("locked");
    expect(panel.hidden).toBe(false);
    expect(textarea.readOnly).toBe(true);
    expect(editButton!.hidden).toBe(false);
  });

  test("editable mode reveals the panel and leaves the textarea editable", () => {
    const { panel, textarea } = setup("editable");
    expect(panel.hidden).toBe(false);
    expect(textarea.readOnly).toBe(false);
  });

  test("searching fills the select with a placeholder plus each address", async () => {
    let requested = "";
    let credentials = "";
    stubFetch((url, init) => {
      requested = url;
      credentials = String(init?.credentials);
      return Promise.resolve(
        jsonResponse({ addresses: ["10 Downing Street", "11 Downing Street"] }),
      );
    });
    const { findButton, resultsLabel, searchInput, select, status } =
      setup("editable");
    searchInput.value = "sw1a 2aa";

    findButton.dispatch("click");
    await flush();

    expect(requested).toBe("/address-lookup?search=sw1a%202aa");
    expect(credentials).toBe("same-origin");
    expect(select.children.map((o) => o.value)).toEqual([
      "",
      "10 Downing Street",
      "11 Downing Street",
    ]);
    expect(select.children[0]!.textContent).toBe("Select an address…");
    expect(select.children[1]!.textContent).toBe("10 Downing Street");
    expect(resultsLabel.hidden).toBe(false);
    expect(status.hidden).toBe(true);
  });

  test("shows the searching message while the lookup is in flight", async () => {
    stubFetch(() => new Promise(() => {})); // never resolves
    const { findButton, searchInput, status } = setup("editable");
    searchInput.value = "SW1A 2AA";

    findButton.dispatch("click");
    await flush();

    expect(status.textContent).toBe("Searching…");
    expect(status.hidden).toBe(false);
  });

  test("an error response that still carries addresses is an error", async () => {
    // The status code decides — a failing response never populates the select.
    stubFetch(() =>
      Promise.resolve(jsonResponse({ addresses: ["10 Downing Street"] }, 500)),
    );
    const { findButton, searchInput, select, status } = setup("editable");
    searchInput.value = "SW1A 2AA";

    findButton.dispatch("click");
    await flush();

    expect(status.textContent).toBe("Lookup failed");
    expect(select.children.length).toBe(0);
  });

  test("an empty search box never calls the endpoint", async () => {
    stubFetch(() => Promise.reject(new Error("should not be called")));
    const { findButton, searchInput } = setup("editable");
    searchInput.value = "   ";

    findButton.dispatch("click");
    await flush();

    expect(callCount()).toBe(0);
  });

  test("Enter in the search box searches instead of submitting the form", async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ addresses: ["A"] })));
    const { searchInput, select } = setup("editable");
    searchInput.value = "SW1A 2AA";
    let prevented = false;

    searchInput.dispatch("keydown", {
      key: "Enter",
      preventDefault: () => {
        prevented = true;
      },
    });
    await flush();

    expect(prevented).toBe(true);
    expect(select.children.length).toBe(2);
  });

  test("other keys in the search box are ignored", async () => {
    stubFetch(() => Promise.reject(new Error("should not be called")));
    const { searchInput } = setup("editable");
    searchInput.value = "SW1A 2AA";

    searchInput.dispatch("keydown", { key: "a", preventDefault: () => {} });
    await flush();

    expect(callCount()).toBe(0);
  });

  test("no matches shows the no-results message and keeps the select hidden", async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ addresses: [] })));
    const { findButton, resultsLabel, searchInput, status } = setup("editable");
    searchInput.value = "ZZ99 9ZZ";

    findButton.dispatch("click");
    await flush();

    expect(status.textContent).toBe("No addresses found");
    expect(status.hidden).toBe(false);
    expect(resultsLabel.hidden).toBe(true);
  });

  /** Run a search with the current fetch stub and assert the shown status. */
  const searchExpectingStatus = async (expected: string): Promise<void> => {
    const { findButton, searchInput, status } = setup("editable");
    searchInput.value = "SW1A 2AA";

    findButton.dispatch("click");
    await flush();

    expect(status.textContent).toBe(expected);
    expect(status.hidden).toBe(false);
  };

  test("a server error shows the server's message", async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ error: "Not a valid postcode" }, 400)),
    );
    await searchExpectingStatus("Not a valid postcode");
  });

  test("a 200 with no address list falls back to the panel's error copy", async () => {
    stubFetch(() => Promise.resolve(jsonResponse({})));
    await searchExpectingStatus("Lookup failed");
  });

  test("a network failure falls back to the panel's error copy", async () => {
    stubFetch(() => Promise.reject(new Error("offline")));
    await searchExpectingStatus("Lookup failed");
  });

  test("a panel missing a copy attribute falls back to empty text", async () => {
    // The server always renders every data-* string; if one is missing the
    // status simply stays blank instead of showing "undefined".
    stubFetch(() => Promise.resolve(jsonResponse({ addresses: [] })));
    const bare = panelSpec("editable");
    bare.data = { addressLookup: "editable" };
    const [form] = installFakeDom([
      { children: [bare, { name: "address", tag: "textarea" }], tag: "form" },
    ]);
    initAddressLookup();
    const searchInput = form!.querySelector("[data-address-search]")!;
    searchInput.value = "SW1A 2AA";

    form!.querySelector("[data-address-find]")!.dispatch("click");
    await flush();

    const status = form!.querySelector("[data-address-status]")!;
    expect(status.textContent).toBe("");
    expect(status.hidden).toBe(true);
  });

  test("choosing an address replaces whatever the textarea held", () => {
    const { select, textarea } = setup("editable");
    textarea.value = "half-typed address";
    select.value = "10 Downing Street, LONDON";

    select.dispatch("change");

    expect(textarea.value).toBe("10 Downing Street, LONDON");
  });

  test("choosing the placeholder leaves the textarea alone", () => {
    const { select, textarea } = setup("locked");
    textarea.value = "already chosen";
    select.value = "";

    select.dispatch("change");

    expect(textarea.value).toBe("already chosen");
  });

  test("Edit unlocks the textarea for corrections and focuses it", () => {
    const { editButton, textarea } = setup("locked");

    editButton!.dispatch("click");

    expect(textarea.readOnly).toBe(false);
    expect(editButton!.hidden).toBe(true);
    expect(textarea.focused).toBe(true);
  });

  test("submitting with a locked empty address unlocks and resubmits", () => {
    const { form, textarea } = setup("locked");
    let prevented = false;

    form.dispatch("submit", {
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(true);
    expect(textarea.readOnly).toBe(false);
  });

  test("submitting with a chosen address goes straight through", () => {
    const { form, textarea } = setup("locked");
    textarea.value = "10 Downing Street";
    let prevented = false;

    form.dispatch("submit", {
      preventDefault: () => {
        prevented = true;
      },
    });

    expect(prevented).toBe(false);
    expect(textarea.readOnly).toBe(true);
  });
});
