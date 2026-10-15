import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { AppleWalletForm } from "#templates/admin/settings/apple-wallet.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("AppleWalletForm", () => {
  beforeAll(setupAdminPageTest);

  test("renders the pass type id and team id as capped text inputs", () => {
    const html = String(
      AppleWalletForm({
        ...advancedDefaultState,
        appleWalletPassTypeId: "pass.com.example.tickets",
        appleWalletTeamId: "ABC1234567",
      }),
    );

    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="apple_wallet_pass_type_id" placeholder="pass.com.example.tickets" type="text" value="pass.com.example.tickets">`,
    );
    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="apple_wallet_team_id" placeholder="ABC1234567" type="text" value="ABC1234567">`,
    );
    says(html, "<label>Pass Type ID<input");
    says(html, "<label>Team ID<input");
  });

  test("renders the three PEM secret fields textareas, empty until configured", () => {
    const html = String(AppleWalletForm(advancedDefaultState));

    for (const name of [
      "apple_wallet_signing_cert",
      "apple_wallet_signing_key",
      "apple_wallet_wwdr_cert",
    ]) {
      says(html, `maxlength="${MAX_TEXTAREA_LENGTH}" name="${name}"`);
      says(html, `name="${name}" placeholder="-----BEGIN`);
    }
    says(html, "<label>Signing Certificate (PEM)<textarea");
    says(html, "<label>Signing Private Key (PEM)<textarea");
    says(html, "<label>WWDR Certificate (PEM)<textarea");
    assert(!html.includes(MASK_SENTINEL));
  });

  test("masks every saved secret once the site has its own credentials", () => {
    const html = String(
      AppleWalletForm({ ...advancedDefaultState, appleWalletConfigured: true }),
    );

    expect(html.match(/<textarea[^>]*>/g)).toHaveLength(3);
    expect(
      html.match(new RegExp(`>${MASK_SENTINEL}</textarea>`, "g")),
    ).toHaveLength(3);
  });

  test("points its heading, action, and guide link at the Apple Wallet route", () => {
    const html = String(AppleWalletForm(advancedDefaultState));

    says(html, "<h2>Apple Wallet</h2>");
    says(html, 'action="/admin/settings/apple-wallet"');
    says(html, 'id="settings-apple-wallet"');
    says(html, 'href="/admin/guide#apple-wallet"');
    says(html, "Save Apple Wallet Settings");
    says(html, "Add to Apple Wallet");
  });

  test("carries the host-config hint in both override states", () => {
    const fallingBack = AppleWalletForm({
      ...advancedDefaultState,
      hostAppleWalletLabel: "Host wallet",
    });
    says(
      String(fallingBack),
      "Currently using: Host wallet. Override below or leave empty to keep using host config.",
    );

    const overriding = AppleWalletForm({
      ...advancedDefaultState,
      appleWalletConfigured: true,
      hostAppleWalletLabel: "Host wallet",
    });
    says(String(overriding), " Overriding: Host wallet.");
  });
});
