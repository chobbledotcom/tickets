import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { flashConsumed, runWithFlashContext } from "#shared/flash-context.ts";
import { Flash, renderError, renderSuccess } from "#shared/forms/flash.tsx";

describe("Flash", () => {
  test("renders a success message inside a success alert", () => {
    const html = String(Flash({ success: "Saved" }));
    expect(html).toContain('class="success"');
    expect(html).toContain("Saved");
  });

  test("consumes the request flash for any single flash kind", () => {
    // Rendering one message must consume the flash, whatever kind it is, so
    // the Layout backstop does not show it a second time on the same request.
    for (const field of ["error", "success", "info"] as const) {
      runWithFlashContext(() => {
        const html = String(Flash({ [field]: "Message" }));
        expect(html).toContain("Message");
        expect(flashConsumed()).toBe(true);
      });
    }
  });

  test("leaves the request flash alone when there is no message", () => {
    runWithFlashContext(() => {
      String(Flash({}));
      expect(flashConsumed()).toBe(false);
    });
  });

  test("renders an info message inside an info alert", () => {
    const html = String(Flash({ info: "Heads up" }));
    expect(html).toContain('class="info"');
    expect(html).toContain("Heads up");
  });

  test("renders an error message inside the error alert", () => {
    const html = String(Flash({ error: "Bad" }));
    expect(html).toContain("Bad");
  });

  test("renders nothing when no field carries a message", () => {
    const html = String(Flash({}));
    expect(html).not.toContain('class="success"');
    expect(html).not.toContain('class="info"');
    expect(html).not.toContain("alert");
  });
});

describe("renderError", () => {
  test("renders the error message as text", () => {
    expect(renderError("Payment refused")).toContain("Payment refused");
  });

  test("renders nothing when there is no error", () => {
    expect(renderError()).toBe("");
  });
});

describe("renderSuccess", () => {
  test("renders the success message inside a success alert", () => {
    const html = renderSuccess("Saved");
    expect(html).toContain('class="success"');
    expect(html).toContain("Saved");
  });

  test("renders nothing when there is no message", () => {
    expect(renderSuccess()).toBe("");
  });
});
