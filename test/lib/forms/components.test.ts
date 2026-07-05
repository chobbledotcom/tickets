import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { flashConsumed, runWithFlashContext } from "#shared/flash-context.ts";
import { ConfirmForm, Flash } from "#shared/forms.tsx";

describe("Flash", () => {
  // Rendering any banner must mark the request's flash consumed so the Layout
  // backstop doesn't render it a second time. Each banner type triggers it.
  const consumesFor = (props: {
    error?: string;
    success?: string;
    info?: string;
  }) =>
    runWithFlashContext(() => {
      expect(flashConsumed()).toBe(false);
      String(Flash(props));
      return flashConsumed();
    });

  test("consumes the flash when rendering an error banner", () => {
    expect(consumesFor({ error: "boom" })).toBe(true);
  });

  test("consumes the flash when rendering a success banner", () => {
    expect(consumesFor({ success: "yay" })).toBe(true);
  });

  test("consumes the flash when rendering an info banner", () => {
    expect(consumesFor({ info: "fyi" })).toBe(true);
  });

  test("does not consume the flash when there is no message", () => {
    const consumed = runWithFlashContext(() => {
      String(Flash({}));
      return flashConsumed();
    });
    expect(consumed).toBe(false);
  });
});

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
