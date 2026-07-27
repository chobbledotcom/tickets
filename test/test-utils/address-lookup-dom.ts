/**
 * Fake-DOM fixtures for the address-lookup client tests: the server-rendered
 * search panel's element spec and the async-settle helper, shared by the
 * base client test and the coordinates/differences test.
 */

import type { ElementSpec, FakeElement } from "#test-utils/fake-dom.ts";

/** The server-rendered address-lookup panel, as an element spec. */
export const panelSpec = (): ElementSpec => ({
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
  ],
  data: {
    addressLookup: "",
    error: "Lookup failed",
    noResults: "No addresses found",
    placeholder: "Select an address…",
    searching: "Searching…",
  },
  hidden: true,
  tag: "div",
});

/** The differences-notice output element, as an element spec. */
export const diffSpec = (): ElementSpec => ({
  data: { addressDiff: "", diffHeading: "Differs:" },
  hidden: true,
  tag: "output",
});

/** A form holding the lookup panel and the address textarea, plus whatever
 *  else the page under test needs (the differences notice, pin inputs). */
export const addressFormSpec = (extras: ElementSpec[] = []): ElementSpec => ({
  children: [panelSpec(), { name: "address", tag: "textarea" }, ...extras],
  tag: "form",
});

/** Look up one element inside the installed form, failing if it is missing. */
export const oneIn =
  (form: FakeElement): ((selector: string) => FakeElement) =>
  (selector: string): FakeElement => {
    const found = form.querySelector(selector);
    if (!found) throw new Error(`No ${selector} in the address-lookup form`);
    return found;
  };

/** Let an async search settle (fetch → json → DOM writes). */
export const flushLookup = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
