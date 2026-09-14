import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { MaskedInput } from "#templates/components/masked-input.tsx";

describe("MaskedInput", () => {
  test("shows the mask sentinel as the value of a stored secret", () => {
    const html = String(
      MaskedInput({
        configured: true,
        label: "API Key",
        name: "email_api_key",
        placeholder: "Enter API key",
      }),
    );

    expect(html).toBe(
      `<label>API Key<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password" value="${MASK_SENTINEL}"></label>`,
    );
  });

  test("renders no value when no secret is stored yet", () => {
    const html = String(
      MaskedInput({
        configured: false,
        label: "API Key",
        name: "email_api_key",
        placeholder: "Enter API key",
      }),
    );

    expect(html).toBe(
      `<label>API Key<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email_api_key" placeholder="Enter API key" type="password"></label>`,
    );
    expect(html).not.toContain("value=");
  });

  test("keeps a declared maxlength over the shared default", () => {
    const html = String(
      MaskedInput({
        configured: false,
        label: "Webhook secret",
        maxlength: 64,
        name: "the_webhook_secret",
      }),
    );

    expect(html).toContain('maxlength="64"');
    expect(html).not.toContain(`maxlength="${MAX_INPUT_LENGTH}"`);
  });
});
