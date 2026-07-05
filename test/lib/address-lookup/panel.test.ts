/**
 * The server-rendered postcode search panel: gated on the configured
 * provider, hidden by default, carrying all client copy in data attributes,
 * and threaded onto the address field by getTicketFields (public "locked",
 * admin "editable").
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { type Field, renderField, renderFields } from "#shared/forms.tsx";
import { renderAddressLookupPanel } from "#templates/components/address-lookup.tsx";
import { getAddAttendeeFields, getTicketFields } from "#templates/fields.ts";

const enableProviderForTest = (): void => {
  settings.setForTest({ address_lookup_provider: "easypostcodes" });
};

afterEach(() => {
  settings.clearTestOverrides();
});

describe("renderAddressLookupPanel", () => {
  test("renders nothing while no provider is configured", () => {
    expect(renderAddressLookupPanel("locked")).toBe("");
  });

  test("renders nothing for an unrecognised stored provider value", () => {
    settings.setForTest({ address_lookup_provider: "surprise" });
    expect(renderAddressLookupPanel("locked")).toBe("");
  });

  test("renders a hidden panel with the provider's search copy", () => {
    enableProviderForTest();
    const html = renderAddressLookupPanel("locked");
    expect(html).toContain('data-address-lookup="locked"');
    expect(html).toContain("hidden");
    expect(html).toContain(">Postcode<");
    expect(html).toContain('placeholder="e.g. SW1A 1AA"');
    expect(html).toContain(">Find address<");
    expect(html).toContain("data-address-search");
    expect(html).toContain("data-address-results");
    expect(html).toContain("data-address-status");
    expect(html).toContain('data-searching="Searching…"');
    expect(html).toContain("data-no-results=");
    expect(html).toContain("data-error=");
    expect(html).toContain("data-placeholder=");
  });

  test("locked mode has an Edit button; editable mode does not", () => {
    enableProviderForTest();
    expect(renderAddressLookupPanel("locked")).toContain("data-address-edit");
    expect(renderAddressLookupPanel("editable")).not.toContain(
      "data-address-edit",
    );
  });
});

describe("address field panel threading", () => {
  const addressField = (fields: Field[]): Field =>
    fields.find((f) => f.name === "address")!;

  test("public ticket fields lock the address behind the panel", () => {
    enableProviderForTest();
    const field = addressField(getTicketFields("address", false));
    expect(field.beforeHtml).toContain('data-address-lookup="locked"');
  });

  test("admin add-attendee fields keep the address editable", () => {
    enableProviderForTest();
    const field = addressField(getAddAttendeeFields("address", false));
    expect(field.beforeHtml).toContain('data-address-lookup="editable"');
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
    const panelAt = html.indexOf('data-address-lookup="locked"');
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
