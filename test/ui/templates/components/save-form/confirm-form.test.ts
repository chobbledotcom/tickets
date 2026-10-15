import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { ConfirmForm } from "#templates/components/save-form.tsx";
import { says } from "#test-utils/says.ts";

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
    says(html, 'class="danger"');
    // A danger confirm carries the bin icon; a safe confirm the check icon.
    says(html, "#trash-2");
    assert(!html.includes("#check"));
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
    says(html, "#check");
    assert(!html.includes("#trash-2"));
    assert(!html.includes('class="danger"'));
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
    says(html, 'name="confirm_identifier"');
    // The typed-name box must not offer or remember completions.
    says(html, '<input autocomplete="off" name="confirm_identifier"');
    says(html, 'type="text"');
  });

  test("omits the confirm input when confirmName is false", () => {
    const html = String(
      ConfirmForm({ action: "/x", buttonText: "OK", confirmName: false }),
    );
    assert(!html.includes('name="confirm_identifier"'));
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
    says(html, 'class="prose"');
    says(html, "Warning text");
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
    says(html, 'name="return_url"');
    says(html, 'value="/back"');
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
    says(html, 'id="restore-confirm"');
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
    says(html, 'name="foo"');
    says(html, 'value="bar"');
  });
});
