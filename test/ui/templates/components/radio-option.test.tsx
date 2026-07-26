import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { RadioOption } from "#templates/components/radio-option.tsx";

describe("RadioOption", () => {
  test("labels a radio input with its children", () => {
    const html = String(
      <RadioOption checked={false} name="theme" value="dark">
        Dark
      </RadioOption>,
    );

    expect(html).toBe(
      '<label><input name="theme" type="radio" value="dark">Dark</label>',
    );
  });

  test("marks the chosen option checked", () => {
    const html = String(
      <RadioOption checked name="theme" value="light">
        Light
      </RadioOption>,
    );

    expect(html).toContain("checked");
  });

  test("switches the input off when disabled", () => {
    const html = String(
      <RadioOption checked={false} disabled name="theme" value="light">
        Light
      </RadioOption>,
    );

    expect(html).toContain("disabled");
  });

  test("leaves the input on when not disabled", () => {
    const html = String(
      <RadioOption checked={false} disabled={false} name="theme" value="light">
        Light
      </RadioOption>,
    );

    expect(html).not.toContain("disabled");
  });
});
