import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { TextField } from "#templates/components/text-field.tsx";

describe("TextField", () => {
  test("renders a labelled text input capped at the shared input length", () => {
    const html = String(
      TextField({
        label: "Business email",
        name: "business_email",
        type: "text",
      }),
    );

    expect(html).toBe(
      `<label>Business email<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="business_email" type="text"></label>`,
    );
  });

  test("caps email and url inputs at the same shared length", () => {
    const html = String(
      <>
        {TextField({ label: "Your email", name: "email", type: "email" })}
        {TextField({ label: "Server", name: "server_url", type: "url" })}
      </>,
    );

    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="email" type="email">`,
    );
    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="server_url" type="url">`,
    );
  });

  test("keeps an explicitly declared maxlength over the default", () => {
    const html = String(
      TextField({
        label: "Postcode",
        maxlength: 8,
        name: "postcode",
        type: "text",
      }),
    );

    expect(html).toContain('maxlength="8"');
    expect(html).not.toContain(`maxlength="${MAX_INPUT_LENGTH}"`);
  });

  test("carries value, placeholder, and required when given", () => {
    const html = String(
      TextField({
        label: "Display name",
        name: "display_name",
        placeholder: "As printed on the ticket",
        required: true,
        type: "text",
        value: "Robin",
      }),
    );

    expect(html).toBe(
      `<label>Display name<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="display_name" placeholder="As printed on the ticket" required type="text" value="Robin"></label>`,
    );
  });

  test("marks duplicate-preview fields and carries numeric bounds", () => {
    const html = String(
      TextField({
        duplicate: true,
        label: "Price",
        max: "10",
        min: "0",
        name: "price",
        step: "0.1",
        type: "number",
      }),
    );

    expect(html).toBe(
      `<label>Price<input autocomplete="off" data-duplicate-field="price" max="10" maxlength="${MAX_INPUT_LENGTH}" min="0" name="price" step="0.1" type="number"></label>`,
    );
  });

  test("caps a password input at the shared length until a caller narrows it", () => {
    // The cap is this component's default for every type: short single-line
    // values are its norm, so an unset maxlength never ships uncapped.
    const html = String(
      TextField({ label: "Secret", name: "the_secret", type: "password" }),
    );

    expect(html).toContain(
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="the_secret" type="password">`,
    );
  });
});
