import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { ConfirmForm } from "#templates/components/save-form.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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
    expectIncludesAll(html, [
      'class="danger"',
      // A danger confirm carries the bin icon; a safe confirm the check icon.
      "#trash-2",
    ]);
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
    expectIncludesAll(html, [
      'name="confirm_identifier"',
      // The typed-name box must not offer or remember completions.
      '<input autocomplete="off" name="confirm_identifier"',
      'type="text"',
    ]);
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
    expectIncludesAll(html, ['class="prose"', "Warning text"]);
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
    expectIncludesAll(html, ['name="return_url"', 'value="/back"']);
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
    expectIncludesAll(html, ['name="foo"', 'value="bar"']);
  });
});
