import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { MaskedTextarea } from "#templates/components/masked-textarea.tsx";

describe("MaskedTextarea", () => {
  test("shows the mask sentinel body for a stored credential", () => {
    const html = String(
      MaskedTextarea({
        configured: true,
        labelKey: "settings.advanced.apple_signing_cert",
        name: "apple_wallet_signing_cert",
        placeholder: "-----BEGIN CERTIFICATE-----",
      }),
    );

    expect(html).toBe(
      `<label>Signing Certificate (PEM)<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="apple_wallet_signing_cert" placeholder="-----BEGIN CERTIFICATE-----" rows="4">${MASK_SENTINEL}</textarea></label>`,
    );
  });

  test("renders an empty body when the credential is not stored", () => {
    const html = String(
      MaskedTextarea({
        configured: false,
        labelKey: "settings.advanced.google_service_key",
        name: "google_wallet_service_account_key",
        placeholder: "-----BEGIN PRIVATE KEY-----",
      }),
    );

    expect(html).toContain(
      `<label>Service Account Private Key (PEM)<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="google_wallet_service_account_key" placeholder="-----BEGIN PRIVATE KEY-----" rows="4"></textarea></label>`,
    );
    expect(html).not.toContain(MASK_SENTINEL);
  });

  test("keeps a declared maxlength over the textarea default", () => {
    const html = String(
      MaskedTextarea({
        configured: false,
        labelKey: "settings.advanced.apple_signing_key",
        maxlength: 100,
        name: "apple_wallet_signing_key",
        placeholder: "-----BEGIN PRIVATE KEY-----",
      }),
    );

    expect(html).toContain('maxlength="100"');
    expect(html).not.toContain(`maxlength="${MAX_TEXTAREA_LENGTH}"`);
  });
});
