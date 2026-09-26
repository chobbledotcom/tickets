import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ConfirmForm } from "#templates/components/save-form.tsx";

describe("ConfirmForm", () => {
  test("defaults to danger styling", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "Delete",
        label: "L",
        name: "n",
      }),
    );
    expect(html).toContain('class="danger"');
    // A danger confirm carries the bin icon; a safe confirm the check icon.
    expect(html).toContain("#trash-2");
    expect(html).not.toContain("#check");
  });

  test("gives a non-danger confirm the check icon", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "OK",
        confirmName: false,
        danger: false,
      }),
    );
    expect(html).toContain("#check");
    expect(html).not.toContain("#trash-2");
    expect(html).not.toContain('class="danger"');
  });

  test("renders the confirm_identifier input by default", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "Delete",
        label: "L",
        name: "n",
      }),
    );
    expect(html).toContain('name="confirm_identifier"');
    // The typed-name box must not offer or remember completions.
    expect(html).toContain(
      '<input autocomplete="off" name="confirm_identifier"',
    );
    expect(html).toContain('type="text"');
  });

  test("omits the confirm input when confirmName is false", () => {
    const html = String(
      ConfirmForm({ action: "/x", buttonText: "OK", confirmName: false }),
    );
    expect(html).not.toContain('name="confirm_identifier"');
  });

  test("wraps children in a prose div", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "OK",
        children: "Warning text",
        confirmName: false,
      }),
    );
    expect(html).toContain('class="prose"');
    expect(html).toContain("Warning text");
  });

  test("renders a hidden return_url input when returnUrl is given", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "OK",
        confirmName: false,
        returnUrl: "/back",
      }),
    );
    expect(html).toContain('name="return_url"');
    expect(html).toContain('value="/back"');
  });

  test("renders the form with the given id", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "OK",
        confirmName: false,
        id: "restore-confirm",
      }),
    );
    expect(html).toContain('id="restore-confirm"');
  });

  test("renders hidden inputs for each hiddenFields entry", () => {
    const html = String(
      ConfirmForm({
        action: "/x",
        buttonText: "OK",
        confirmName: false,
        hiddenFields: { foo: "bar" },
      }),
    );
    expect(html).toContain('name="foo"');
    expect(html).toContain('value="bar"');
  });
});
