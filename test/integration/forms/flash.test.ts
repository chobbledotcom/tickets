import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import {
  type Flash as FlashMessage,
  setFlashContext,
  setFlashFormId,
} from "#shared/flash-context.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import {
  Flash,
  renderError,
  renderSuccess,
  requestFlash,
} from "#shared/forms/flash.tsx";
import { detectIframeMode } from "#shared/request-context.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { says } from "#test-utils/says.ts";

/** Render a CsrfForm inside a flash context targeting `formId`, so the form's
 *  inline-flash branch (id === target form) can be exercised. */
const csrfFormInFlash = (
  props: { action: string; id?: string },
  flash: FlashMessage,
  formId: string | null,
): Promise<string> =>
  withRequestContext(() => {
    setFlashContext(flash);
    setFlashFormId(formId);
    return String(CsrfForm(props));
  });

describe("renderError", () => {
  test("returns empty string when no error", () => {
    expect(renderError()).toBe("");
    expect(renderError(undefined)).toBe("");
  });

  test("renders error with role alert", () => {
    const html = renderError("Something went wrong");
    says(html, "Something went wrong");
    says(html, 'class="error"');
    says(html, 'role="alert"');
  });

  test("escapes HTML in error message", () => {
    const html = renderError("<script>alert(1)</script>");
    says(html, "&lt;script&gt;");
    assert(!html.includes("<script>"));
  });
});

describe("renderSuccess", () => {
  test("returns empty string when no message", () => {
    expect(renderSuccess()).toBe("");
    expect(renderSuccess(undefined)).toBe("");
  });

  test("renders success message with role alert", () => {
    const html = renderSuccess("Changes saved");
    says(html, "Changes saved");
    says(html, 'class="success"');
    says(html, 'role="alert"');
  });

  test("escapes HTML in success message", () => {
    const html = renderSuccess("<script>alert(1)</script>");
    says(html, "&lt;script&gt;");
    assert(!html.includes("<script>"));
  });
});

describe("Flash", () => {
  test("renders nothing when no error or success", () => {
    const html = String(Flash({}));
    assert(!html.includes('class="error"'));
    assert(!html.includes('class="success"'));
  });

  test("renders error with role alert", () => {
    const html = String(Flash({ error: "Bad input" }));
    says(html, "Bad input");
    says(html, 'class="error"');
    says(html, 'role="alert"');
    assert(!html.includes('class="success"'));
  });

  test("renders success with role alert", () => {
    const html = String(Flash({ success: "Saved" }));
    says(html, "Saved");
    says(html, 'class="success"');
    says(html, 'role="alert"');
    assert(!html.includes('class="error"'));
  });

  test("renders both error and success", () => {
    const html = String(Flash({ error: "Oops", success: "Done" }));
    says(html, "Oops");
    says(html, "Done");
    says(html, 'class="error"');
    says(html, 'class="success"');
  });

  test("escapes HTML in messages", () => {
    const html = String(Flash({ error: "<script>xss</script>" }));
    says(html, "&lt;script&gt;");
    assert(!html.includes("<script>xss"));
  });
});

test("requestFlash renders every message from the request context", async () => {
  const html = await withRequestContext(() => {
    setFlashContext({ error: "Bad", info: "Notice", success: "Saved" });
    return String(requestFlash());
  });
  says(html, "Bad");
  says(html, "Notice");
  says(html, "Saved");
});

describe("CsrfForm", () => {
  beforeAll(setupAdminPageTest);

  afterEach(() => {
    detectIframeMode(new URL("https://example.com/"));
  });

  test("renders POST form with action and CSRF token", () => {
    const html = String(CsrfForm({ action: "/submit" }));
    says(html, 'action="/submit"');
    says(html, 'method="POST"');
    expect(hasInputWithValue(html, "csrf_token", getCurrentCsrfToken())).toBe(
      true,
    );
  });

  test("passes through class attribute", () => {
    says(
      String(CsrfForm({ action: "/submit", class: "inline" })),
      'class="inline"',
    );
  });

  test("passes through enctype for multipart forms", () => {
    says(
      String(CsrfForm({ action: "/upload", enctype: "multipart/form-data" })),
      'enctype="multipart/form-data"',
    );
  });

  test("passes through id attribute", () => {
    says(
      String(CsrfForm({ action: "/submit", id: "settings-tz" })),
      'id="settings-tz"',
    );
  });

  test("does not render id attribute when not provided", () => {
    assert(!String(CsrfForm({ action: "/submit" })).includes("id="));
  });

  test("renders children inside the form", () => {
    const html = String(
      CsrfForm({ action: "/submit", children: "Submit here" }),
    );
    says(html, "Submit here");
  });

  test("shows success flash when id matches the targeted form", async () => {
    const html = await csrfFormInFlash(
      { action: "/submit", id: "my-form" },
      { success: "Saved" },
      "my-form",
    );
    says(html, "Saved");
    says(html, 'class="success"');
  });

  test("does not show success when id does not match", async () => {
    assert(
      !(
        await csrfFormInFlash(
          { action: "/submit", id: "my-form" },
          { success: "Saved" },
          "other-form",
        )
      ).includes('class="success"'),
    );
  });

  test("does not show success when no id on form", async () => {
    assert(
      !(
        await csrfFormInFlash(
          { action: "/submit" },
          { success: "Saved" },
          "my-form",
        )
      ).includes('class="success"'),
    );
  });

  test("shows error flash when id matches the targeted form", async () => {
    const html = await csrfFormInFlash(
      { action: "/submit", id: "my-form" },
      { error: "Something went wrong" },
      "my-form",
    );
    says(html, "Something went wrong");
    says(html, 'class="error"');
  });

  test("does not show error when id does not match", async () => {
    assert(
      !(
        await csrfFormInFlash(
          { action: "/submit", id: "my-form" },
          { error: "err" },
          "other-form",
        )
      ).includes('class="error"'),
    );
  });

  test("appends ?iframe=true to action when in iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/?iframe=true"));
      says(
        String(CsrfForm({ action: "/ticket/test" })),
        'action="/ticket/test?iframe=true"',
      );
    });
  });

  test("does not append iframe param outside iframe mode", async () => {
    await withRequestContext(() => {
      detectIframeMode(new URL("https://example.com/"));
      const html = String(CsrfForm({ action: "/ticket/test" }));
      says(html, 'action="/ticket/test"');
      assert(!html.includes("iframe"));
    });
  });
});
