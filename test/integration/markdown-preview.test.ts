import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

/** POST helper for the markdown preview endpoint. */
const postPreview = (
  content: string,
  opts: { cookie?: string; csrfToken?: string },
): Promise<Response> => {
  const params: Record<string, string> = { content };
  if (opts.csrfToken !== undefined) params.csrf_token = opts.csrfToken;
  return handleRequest(
    mockRequest("/admin/markdown-preview", {
      body: new URLSearchParams(params).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      method: "POST",
    }),
  );
};

describeWithEnv("Markdown preview endpoint", { db: true }, () => {
  test("renders markdown to HTML for an authenticated admin", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();

    const response = await postPreview("**bold** and _italic_", {
      cookie,
      csrfToken,
    });

    expect(response.status).toBe(200);
    assertStringIncludes(
      response.headers.get("content-type") ?? "",
      "text/html",
    );
    const html = await response.text();
    assertStringIncludes(html, "<strong>bold</strong>");
    assertStringIncludes(html, "<em>italic</em>");
  });

  test("escapes raw script tags so they cannot execute", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();

    const response = await postPreview("<script>alert(1)</script>", {
      cookie,
      csrfToken,
    });

    const html = await response.text();
    assert(
      !html.includes("<script>"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "&lt;script&gt;");
  });

  test("strips javascript: URLs from rendered links", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();

    const response = await postPreview("[x](javascript:alert(1))", {
      cookie,
      csrfToken,
    });

    const html = await response.text();
    assert(
      !html.includes("javascript:"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, '<a href="">x</a>');
  });

  test("redirects unauthenticated requests to the login page", async () => {
    const csrfToken = await testCsrfToken();

    const response = await postPreview("**hi**", { csrfToken });

    // A POST is not navigable after login, so it carries no return target.
    expect(response.headers.get("location")).toBe("/admin");
  });

  test("rejects requests with a missing CSRF token", async () => {
    const cookie = await testCookie();

    const response = await postPreview("**hi**", { cookie });

    expect(response.status).toBe(403);
    assertStringIncludes(await response.text(), "Invalid CSRF token");
  });

  test("rejects requests with an invalid CSRF token", async () => {
    const cookie = await testCookie();

    const response = await postPreview("**hi**", {
      cookie,
      csrfToken: "not-a-real-token",
    });

    expect(response.status).toBe(403);
  });

  test("rejects content longer than the textarea limit", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();

    const response = await postPreview("a".repeat(MAX_TEXTAREA_LENGTH + 1), {
      cookie,
      csrfToken,
    });

    expect(response.status).toBe(413);
    assertStringIncludes(await response.text(), "Content too long");
  });

  test("renders an empty body as empty HTML", async () => {
    const cookie = await testCookie();
    const csrfToken = await testCsrfToken();

    const response = await postPreview("", { cookie, csrfToken });

    expect(response.status).toBe(200);
    expect((await response.text()).trim()).toBe("");
  });
});
