import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ensureCustomCssResponse,
  isSetupPath,
  shouldBufferRequestBody,
  trackingRedirectLocation,
} from "#routes/app/rules.ts";

const request = (method: string, contentType?: string): Request =>
  new Request("https://example.com/path", {
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
    method,
  });

describe("request rules", () => {
  test("buffers each body type read by a POST handler", () => {
    for (const contentType of [
      "application/x-www-form-urlencoded; charset=utf-8",
      "multipart/form-data; boundary=test",
      "Application/JSON; charset=utf-8",
    ]) {
      expect(shouldBufferRequestBody(request("POST", contentType))).toBe(true);
    }
  });

  test("does not buffer bodyless, unused, or non-POST bodies", () => {
    expect(shouldBufferRequestBody(request("POST"))).toBe(false);
    expect(shouldBufferRequestBody(request("POST", "text/plain"))).toBe(false);
    expect(shouldBufferRequestBody(request("PUT", "application/json"))).toBe(
      false,
    );
  });

  test("recognizes only the setup path family", () => {
    expect(isSetupPath("/setup")).toBe(true);
    expect(isSetupPath("/setup/")).toBe(true);
    expect(isSetupPath("/setup/account")).toBe(true);
    expect(isSetupPath("/setups")).toBe(false);
    expect(isSetupPath("/")).toBe(false);
  });

  test("returns a clean location only for tracked GET requests", () => {
    const tracked = new URL(
      "https://example.com/ticket/one?keep=yes&utm_source=test",
    );
    expect(trackingRedirectLocation(tracked, "GET")).toBe(
      "/ticket/one?keep=yes",
    );
    expect(trackingRedirectLocation(tracked, "POST")).toBeNull();
    expect(
      trackingRedirectLocation(
        new URL("https://example.com/ticket/one"),
        "GET",
      ),
    ).toBeNull();
  });

  test("turns an HTML custom CSS fallback into an empty stylesheet", async () => {
    const response = ensureCustomCssResponse(
      "/custom.css",
      new Response("<h1>Error</h1>", {
        headers: { "content-type": "text/html" },
      }),
    );
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(await response.text()).toBe("");
  });

  test("preserves valid CSS, redirects, and responses for other paths", () => {
    const css = new Response("body {}", {
      headers: { "content-type": "text/css" },
    });
    const redirect = new Response(null, { status: 301 });
    const html = new Response("page", {
      headers: { "content-type": "text/html" },
    });
    expect(ensureCustomCssResponse("/custom.css", css)).toBe(css);
    expect(ensureCustomCssResponse("/custom.css", redirect)).toBe(redirect);
    expect(ensureCustomCssResponse("/other", html)).toBe(html);
  });
});
