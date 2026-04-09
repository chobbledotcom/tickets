import { expect } from "@std/expect";
import { afterEach, beforeAll, describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken, signCsrfToken } from "#lib/csrf.ts";
import { detectIframeMode } from "#lib/iframe.ts";
import {
  CsrfForm,
  Flash,
  renderError,
  renderSuccess,
  setFormError,
  setFormSuccess,
} from "#lib/forms.tsx";
import { setupTestEncryptionKey } from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("renderError", () => {
  test("returns empty string when no error", () => {
    expect(renderError()).toBe("");
    expect(renderError(undefined)).toBe("");
  });

  test("renders error with role alert", () => {
    const html = renderError("Something went wrong");
    expect(html).toContain("Something went wrong");
    expect(html).toContain('class="error"');
    expect(html).toContain('role="alert"');
  });

  test("escapes HTML in error message", () => {
    const html = renderError("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("renderSuccess", () => {
  test("returns empty string when no message", () => {
    expect(renderSuccess()).toBe("");
    expect(renderSuccess(undefined)).toBe("");
  });

  test("renders success message with role alert", () => {
    const html = renderSuccess("Changes saved");
    expect(html).toContain("Changes saved");
    expect(html).toContain('class="success"');
    expect(html).toContain('role="alert"');
  });

  test("escapes HTML in success message", () => {
    const html = renderSuccess("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("Flash", () => {
  test("renders nothing when no error or success", () => {
    const html = String(Flash({}));
    expect(html).not.toContain('class="error"');
    expect(html).not.toContain('class="success"');
  });

  test("renders error with role alert", () => {
    const html = String(Flash({ error: "Bad input" }));
    expect(html).toContain("Bad input");
    expect(html).toContain('class="error"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('class="success"');
  });

  test("renders success with role alert", () => {
    const html = String(Flash({ success: "Saved" }));
    expect(html).toContain("Saved");
    expect(html).toContain('class="success"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('class="error"');
  });

  test("renders both error and success", () => {
    const html = String(Flash({ error: "Oops", success: "Done" }));
    expect(html).toContain("Oops");
    expect(html).toContain("Done");
    expect(html).toContain('class="error"');
    expect(html).toContain('class="success"');
  });

  test("escapes HTML in messages", () => {
    const html = String(Flash({ error: "<script>xss</script>" }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>xss");
  });
});

describe("CsrfForm", () => {
  afterEach(() => {
    setFormSuccess("", "");
    setFormError("", "");
    detectIframeMode("https://example.com/");
  });

  test("renders POST form with action and CSRF token", () => {
    const html = String(CsrfForm({ action: "/submit" }));
    expect(html).toContain('<form method="POST" action="/submit"');
    expect(html).toContain(`<input type="hidden" name="csrf_token" value="${getCurrentCsrfToken()}"`);
  });

  test("passes through class attribute", () => {
    expect(String(CsrfForm({ action: "/submit", class: "inline" }))).toContain('class="inline"');
  });

  test("passes through enctype for multipart forms", () => {
    expect(String(CsrfForm({ action: "/upload", enctype: "multipart/form-data" }))).toContain('enctype="multipart/form-data"');
  });

  test("passes through id attribute", () => {
    expect(String(CsrfForm({ action: "/submit", id: "settings-tz" }))).toContain('id="settings-tz"');
  });

  test("does not render id attribute when not provided", () => {
    expect(String(CsrfForm({ action: "/submit" }))).not.toContain("id=");
  });

  test("renders children inside the form", () => {
    const html = String(CsrfForm({ action: "/submit", children: "Submit here" }));
    expect(html).toContain("Submit here");
  });

  test("shows success flash when id matches stored success state", () => {
    setFormSuccess("my-form", "Saved");
    const html = String(CsrfForm({ action: "/submit", id: "my-form" }));
    expect(html).toContain("Saved");
    expect(html).toContain('class="success"');
  });

  test("does not show success when id does not match", () => {
    setFormSuccess("other-form", "Saved");
    expect(String(CsrfForm({ action: "/submit", id: "my-form" }))).not.toContain('class="success"');
  });

  test("does not show success when no id on form", () => {
    setFormSuccess("my-form", "Saved");
    expect(String(CsrfForm({ action: "/submit" }))).not.toContain('class="success"');
  });

  test("shows error flash when id matches stored error state", () => {
    setFormError("my-form", "Something went wrong");
    const html = String(CsrfForm({ action: "/submit", id: "my-form" }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain('class="error"');
  });

  test("does not show error when id does not match", () => {
    setFormError("other-form", "err");
    expect(String(CsrfForm({ action: "/submit", id: "my-form" }))).not.toContain('class="error"');
  });

  test("appends ?iframe=true to action when in iframe mode", () => {
    detectIframeMode("https://example.com/?iframe=true");
    expect(String(CsrfForm({ action: "/ticket/test" }))).toContain('action="/ticket/test?iframe=true"');
  });

  test("does not append iframe param outside iframe mode", () => {
    detectIframeMode("https://example.com/");
    const html = String(CsrfForm({ action: "/ticket/test" }));
    expect(html).toContain('action="/ticket/test"');
    expect(html).not.toContain("iframe");
  });
});
