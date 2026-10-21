/**
 * The server-rendered postcode search panel: gated on the configured
 * provider, hidden by default, carrying all client copy in data attributes,
 * and threaded onto the address field by getTicketFields. The address
 * textarea always stays editable.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import type { Field } from "#shared/forms/field.ts";
import { renderField, renderFields } from "#shared/forms/rendering.tsx";
import { renderAddressLookupPanel } from "#templates/components/address-lookup.tsx";
import { getAddAttendeeFields } from "#templates/fields/add-attendee.ts";
import { getTicketFields } from "#templates/fields/ticket.ts";

const enableProviderForTest = (): void => {
  settings.setForTest({ address_lookup_provider: "easypostcodes" });
};

afterEach(() => {
  settings.clearTestOverrides();
});

describe("renderAddressLookupPanel", () => {
  test("renders nothing while no provider is configured", () => {
    expect(renderAddressLookupPanel()).toBe("");
  });

  test("renders nothing for an unrecognised stored provider value", () => {
    settings.setForTest({ address_lookup_provider: "surprise" });
    expect(renderAddressLookupPanel()).toBe("");
  });

  test("renders a hidden panel with the provider's search copy", () => {
    enableProviderForTest();
    const html = renderAddressLookupPanel();
    assertStringIncludes(html, "data-address-lookup");
    assertStringIncludes(html, "hidden");
    assertStringIncludes(html, ">Postcode<");
    // The search input carries no placeholder (the `data-placeholder` results
    // attribute is a different thing — hence the leading-space match).
    assert(!html.includes(" placeholder="));
    assertStringIncludes(html, ">Find address<");
    assertStringIncludes(html, "data-address-search");
    assertStringIncludes(html, "data-address-results");
    assertStringIncludes(html, "data-address-status");
    assertStringIncludes(html, 'data-searching="Searching…"');
    assertStringIncludes(html, "data-no-results=");
    assertStringIncludes(html, "data-error=");
    assertStringIncludes(html, "data-placeholder=");
  });

  test("never renders an Edit button — the textarea stays editable", () => {
    enableProviderForTest();
    assert(!renderAddressLookupPanel().includes("data-address-edit"));
  });

  test("pre-fills the search box from an address ending in a postcode", () => {
    enableProviderForTest();
    const html = renderAddressLookupPanel("1 High Street, London, SW1A 1AA");
    assertStringIncludes(html, 'value="SW1A 1AA"');
  });

  test("normalises the trailing postcode before pre-filling", () => {
    enableProviderForTest();
    const html = renderAddressLookupPanel("1 High Street, London, sw1a1aa");
    assertStringIncludes(html, 'value="SW1A 1AA"');
  });

  test("leaves the search box empty when the address has no trailing postcode", () => {
    enableProviderForTest();
    const html = renderAddressLookupPanel("1 High Street, London");
    assert(!html.includes("value="));
  });

  test("leaves the search box empty with no address given", () => {
    enableProviderForTest();
    assert(!renderAddressLookupPanel().includes("value="));
  });
});

describe("address field panel threading", () => {
  const addressField = (fields: Field[]): Field =>
    fields.find((f) => f.name === "address")!;

  test("public ticket fields attach the panel to the address field", () => {
    enableProviderForTest();
    const field = addressField(getTicketFields("address", false));
    assertStringIncludes(field.beforeHtml ?? "", "data-address-lookup");
  });

  test("admin add-attendee fields attach the panel to the address field", () => {
    enableProviderForTest();
    const field = addressField(getAddAttendeeFields("address", false));
    assertStringIncludes(field.beforeHtml ?? "", "data-address-lookup");
  });

  test("no provider means the plain field, with no panel attached", () => {
    const field = addressField(getTicketFields("address", false));
    expect(field.beforeHtml).toBeUndefined();
  });

  test("other contact fields never carry the panel", () => {
    enableProviderForTest();
    const fields = getTicketFields("email,phone,address", false);
    for (const field of fields.filter((f) => f.name !== "address")) {
      expect(field.beforeHtml).toBeUndefined();
    }
  });

  test("renderFields emits the panel directly before the address label", () => {
    enableProviderForTest();
    const html = renderFields(getTicketFields("address", false));
    const panelAt = html.indexOf("data-address-lookup");
    const labelAt = html.indexOf('name="address"');
    expect(panelAt).toBeGreaterThan(-1);
    expect(panelAt).toBeLessThan(labelAt);
  });

  test("renderField puts beforeHtml ahead of the label element", () => {
    const html = renderField({
      beforeHtml: "<div>panel</div>",
      label: "Address",
      name: "address",
      type: "textarea",
    });
    expect(html.startsWith("<div>panel</div><label>")).toBe(true);
  });
});
