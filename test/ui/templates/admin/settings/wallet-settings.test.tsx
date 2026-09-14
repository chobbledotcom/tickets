import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  hostOverrideHint,
  WalletSettingsForm,
} from "#templates/admin/settings/wallet-settings.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("hostOverrideHint", () => {
  test("says nothing when the host provides no wallet config", () => {
    expect(hostOverrideHint(null, false)).toBe("");
    expect(hostOverrideHint(null, true)).toBe("");
    expect(hostOverrideHint("", true)).toBe("");
  });

  test("points at the host config the site falls back to", () => {
    expect(hostOverrideHint("Host wallet", false)).toBe(
      " Currently using: Host wallet. Override below or leave empty to keep using host config.",
    );
  });

  test("says when the site overrides the host config", () => {
    expect(hostOverrideHint("Host wallet", true)).toBe(
      " Overriding: Host wallet.",
    );
  });
});

describe("WalletSettingsForm", () => {
  beforeAll(setupAdminPageTest);

  // The scaffold reads its field limits from the registered settings fields,
  // so the probe reuses the Google Wallet form's field names without reusing
  // its page copy.
  const probe = (configured: boolean): string =>
    String(
      WalletSettingsForm({
        action: "/admin/settings/probe-wallet",
        configured,
        description: <p>Probe description.</p>,
        formId: "settings-google-wallet",
        secretFields: [
          {
            labelKey: "settings.advanced.google_service_key",
            name: "google_wallet_service_account_key",
            placeholder: "-----BEGIN PRIVATE KEY-----",
          },
        ],
        submitLabel: "Save the wallet",
        textFields: [
          {
            labelKey: "settings.advanced.google_issuer_id",
            name: "google_wallet_issuer_id",
            placeholder: "3388000000012345678",
            type: "text",
            value: "3388000000012345678",
          },
        ],
        title: "Probe Wallet",
      }),
    );

  test("renders the section shell around the field lists", () => {
    const html = probe(false);

    expect(html).toContain('action="/admin/settings/probe-wallet"');
    expect(html).toContain('id="settings-probe-wallet"');
    expect(html).toContain("<h2>Probe Wallet</h2>");
    expect(html).toContain("Probe description.");
    expect(html).toContain("Save the wallet");
  });

  test("renders each text field with its translated label and value", () => {
    const html = probe(false);

    expect(html).toContain("<label>Issuer ID<input");
    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="google_wallet_issuer_id" placeholder="3388000000012345678" type="text" value="3388000000012345678">`,
    );
  });

  test("masks the secret textarea only once the site saves credentials", () => {
    expect(probe(false)).toContain(
      `<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="google_wallet_service_account_key" placeholder="-----BEGIN PRIVATE KEY-----" rows="4"></textarea>`,
    );

    expect(probe(true)).toContain(`rows="4">${MASK_SENTINEL}</textarea>`);
  });
});
