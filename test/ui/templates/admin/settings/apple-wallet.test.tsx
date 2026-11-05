import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { AppleWalletForm } from "#templates/admin/settings/apple-wallet.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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

    expectIncludesAll(html, [
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="apple_wallet_pass_type_id" placeholder="pass.com.example.tickets" type="text" value="pass.com.example.tickets">`,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="apple_wallet_team_id" placeholder="ABC1234567" type="text" value="ABC1234567">`,
      "<label>Pass Type ID<input",
      "<label>Team ID<input",
    ]);
  });

  test("renders the three PEM secret fields textareas, empty until configured", () => {
    const html = String(AppleWalletForm(advancedDefaultState));

    for (const name of [
      "apple_wallet_signing_cert",
      "apple_wallet_signing_key",
      "apple_wallet_wwdr_cert",
    ]) {
      expectIncludesAll(html, [
        `maxlength="${MAX_TEXTAREA_LENGTH}" name="${name}"`,
        `name="${name}" placeholder="-----BEGIN`,
      ]);
    }
    expectIncludesAll(html, [
      "<label>Signing Certificate (PEM)<textarea",
      "<label>Signing Private Key (PEM)<textarea",
      "<label>WWDR Certificate (PEM)<textarea",
    ]);
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

    expectIncludesAll(html, [
      "<h2>Apple Wallet</h2>",
      'action="/admin/settings/apple-wallet"',
      'id="settings-apple-wallet"',
      'href="/admin/guide#apple-wallet"',
      "Save Apple Wallet Settings",
      "Add to Apple Wallet",
    ]);
  });

  test("carries the host-config hint in both override states", () => {
    const fallingBack = AppleWalletForm({
      ...advancedDefaultState,
      hostAppleWalletLabel: "Host wallet",
    });
    assertStringIncludes(
      String(fallingBack),
      "Currently using: Host wallet. Override below or leave empty to keep using host config.",
    );

    const overriding = AppleWalletForm({
      ...advancedDefaultState,
      appleWalletConfigured: true,
      hostAppleWalletLabel: "Host wallet",
    });
    assertStringIncludes(String(overriding), " Overriding: Host wallet.");
  });
});
