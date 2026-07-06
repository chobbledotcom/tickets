/**
 * Fake-DOM fixtures for the address-lookup client tests: the server-rendered
 * search panel's element spec and the async-settle helper, shared by the
 * base client test and the coordinates/differences test.
 */

import type { ElementSpec } from "#test-utils/fake-dom.ts";

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

/** Let an async search settle (fetch → json → DOM writes). */
export const flushLookup = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
