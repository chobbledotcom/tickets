/** Direct tests for settings/fields.ts — the custom settings form fields the
 *  admin routes render and post. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import type { Field } from "#shared/forms/field.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import {
  CUSTOM_SETTINGS_FIELDS,
  emailTemplateSettingsFields,
  settingsFieldAttributes,
} from "#shared/settings/fields.ts";
import { byName } from "#test-utils/fields.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

const en = await allEnglishMessages(["settings", "sms"]);

/** The custom form ids the settings routes pass to withSettingsFields. */
const ROUTE_FORM_IDS = [
  "settings-apple-wallet",
  "settings-custom-domain",
  "settings-email",
  "settings-google-wallet",
  "settings-host-subdomain",
  "settings-sms-gateway",
  "settings-square",
  "settings-square-webhook",
  "settings-stripe",
  "settings-sumup",
];

/** The fields one custom form declares, or a loud miss. */
const fieldsOf = (formId: string): readonly Field[] => {
  const fields = CUSTOM_SETTINGS_FIELDS[formId];
  if (!fields) throw new Error(`No custom settings fields for ${formId}`);
  return fields();
};

describe("CUSTOM_SETTINGS_FIELDS", () => {
  test("covers exactly the custom form ids the settings routes use", () => {
    expect(Object.keys(CUSTOM_SETTINGS_FIELDS).sort()).toEqual(
      [...ROUTE_FORM_IDS].sort(),
    );
  });

  test("declares every field name exactly once within its form", () => {
    for (const formId of Object.keys(CUSTOM_SETTINGS_FIELDS)) {
      const names = fieldsOf(formId).map((field) => field.name);
      expect(new Set(names).size, formId).toBe(names.length);
      expect(names.length, formId).toBeGreaterThan(0);
    }
  });

  test("labels each field from the catalog key that names it", () => {
    expect(
      byName(fieldsOf("settings-custom-domain"), "custom_domain").label,
    ).toBe(en["settings.advanced.domain_label"]);
    expect(byName(fieldsOf("settings-host-subdomain"), "subdomain").label).toBe(
      en["settings.subdomain.subdomain_label"],
    );
    expect(
      byName(fieldsOf("settings-sms-gateway"), "sms_gateway_username").label,
    ).toBe(en["sms.settings.username"]);
  });

  test("caps every secret at the limit its input kind accepts", () => {
    for (const formId of Object.keys(CUSTOM_SETTINGS_FIELDS)) {
      for (const field of fieldsOf(formId)) {
        if (field.type === "password") {
          expect(field.maxlength, `${formId} ${field.name}`).toBe(
            MAX_INPUT_LENGTH,
          );
        } else if (field.type === "textarea") {
          expect(field.maxlength, `${formId} ${field.name}`).toBe(
            MAX_TEXTAREA_LENGTH,
          );
        }
      }
    }
  });

  test("names each provider's secret field where its save route reads it", () => {
    const secretFields = {
      "settings-square": PAYMENT_PROVIDERS.square.secretField,
      "settings-stripe": PAYMENT_PROVIDERS.stripe.secretField,
      "settings-sumup": PAYMENT_PROVIDERS.sumup.secretField,
    };
    for (const [formId, secretField] of Object.entries(secretFields)) {
      const names = fieldsOf(formId).map((field) => field.name);
      expect(names, formId).toContain(secretField);
    }
  });
});

describe("emailTemplateSettingsFields", () => {
  test("declares the subject line and both bodies", () => {
    const fields = emailTemplateSettingsFields();
    expect(fields.map((field) => field.name)).toEqual([
      "subject",
      "html",
      "text",
    ]);
    expect(fields.map((field) => field.type)).toEqual([
      "text",
      "textarea",
      "textarea",
    ]);
  });

  test("caps the subject like an input and the bodies like templates", () => {
    const fields = emailTemplateSettingsFields();
    expect(settingsFieldAttributes(fields, "subject")).toEqual({
      maxlength: MAX_INPUT_LENGTH,
      name: "subject",
    });
    for (const body of ["html", "text"] as const) {
      expect(settingsFieldAttributes(fields, body)).toEqual({
        maxlength: MAX_EMAIL_TEMPLATE_LENGTH,
        name: body,
      });
    }
  });
});

describe("settingsFieldAttributes", () => {
  test("answers a named field's browser limit", () => {
    const appleWallet = fieldsOf("settings-apple-wallet");
    expect(
      settingsFieldAttributes(appleWallet, "apple_wallet_team_id"),
    ).toEqual({ maxlength: MAX_INPUT_LENGTH, name: "apple_wallet_team_id" });
    expect(
      settingsFieldAttributes(appleWallet, "apple_wallet_signing_cert"),
    ).toEqual({
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "apple_wallet_signing_cert",
    });
  });

  test("throws for a name no declared field carries", () => {
    expect(() =>
      settingsFieldAttributes(fieldsOf("settings-email"), "nope"),
    ).toThrow("Settings field does not exist: nope");
  });
});
