import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(html, 'class="danger"');
    // A danger confirm carries the bin icon; a safe confirm the check icon.
    assertStringIncludes(html, "#trash-2");
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
    assertStringIncludes(html, "#check");
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
    assertStringIncludes(html, 'name="confirm_identifier"');
    // The typed-name box must not offer or remember completions.
    assertStringIncludes(
      html,
      '<input autocomplete="off" name="confirm_identifier"',
    );
    assertStringIncludes(html, 'type="text"');
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
    assertStringIncludes(html, 'class="prose"');
    assertStringIncludes(html, "Warning text");
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
    assertStringIncludes(html, 'name="return_url"');
    assertStringIncludes(html, 'value="/back"');
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
    assertStringIncludes(html, 'id="restore-confirm"');
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
    assertStringIncludes(html, 'name="foo"');
    assertStringIncludes(html, 'value="bar"');
  });
});
