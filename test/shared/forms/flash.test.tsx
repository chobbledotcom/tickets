import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { flashConsumed } from "#shared/flash-context.ts";
import { Flash, renderError, renderSuccess } from "#shared/forms/flash.tsx";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("Flash", () => {
  test("renders a success message inside a success alert", () => {
    const html = String(Flash({ success: "Saved" }));
    assertStringIncludes(html, 'class="success"');
    assertStringIncludes(html, "Saved");
  });

  test("consumes the request flash for any single flash kind", () => {
    // Rendering one message must consume the flash, whatever kind it is, so
    // the Layout backstop does not show it a second time on the same request.
    for (const field of ["error", "success", "info"] as const) {
      withRequestContext(() => {
        const html = String(Flash({ [field]: "Message" }));
        assertStringIncludes(html, "Message");
        expect(flashConsumed()).toBe(true);
      });
    }
  });

  test("leaves the request flash alone when there is no message", () => {
    withRequestContext(() => {
      String(Flash({}));
      expect(flashConsumed()).toBe(false);
    });
  });

  test("renders an info message inside an info alert", () => {
    const html = String(Flash({ info: "Heads up" }));
    assertStringIncludes(html, 'class="info"');
    assertStringIncludes(html, "Heads up");
  });

  test("renders an error message inside the error alert", () => {
    const html = String(Flash({ error: "Bad" }));
    assertStringIncludes(html, "Bad");
  });

  test("renders nothing when no field carries a message", () => {
    const html = String(Flash({}));
    assert(
      !html.includes('class="success"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('class="info"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("alert"),
      "the value should not contain the searched item",
    );
  });
});

describe("renderError", () => {
  test("renders the error message as text", () => {
    assertStringIncludes(renderError("Payment refused"), "Payment refused");
  });

  test("renders nothing when there is no error", () => {
    expect(renderError()).toBe("");
  });
});

describe("renderSuccess", () => {
  test("renders the success message inside a success alert", () => {
    const html = renderSuccess("Saved");
    assertStringIncludes(html, 'class="success"');
    assertStringIncludes(html, "Saved");
  });

  test("renders nothing when there is no message", () => {
    expect(renderSuccess()).toBe("");
  });
});
