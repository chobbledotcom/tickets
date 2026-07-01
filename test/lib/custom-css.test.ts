import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  emptyCustomCssResponse,
  isCssResponse,
} from "#routes/public/custom-css.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv, mockRequest } from "#test-utils";

const customCss = (): Promise<Response> =>
  handleRequest(mockRequest("/custom.css"));

describe("custom.css asset helpers", () => {
  test("isCssResponse is true for a text/css response", () => {
    const res = new Response("", {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
    expect(isCssResponse(res)).toBe(true);
  });

  test("isCssResponse is false for an HTML response", () => {
    const res = new Response("<h1>nope</h1>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(isCssResponse(res)).toBe(false);
  });

  test("isCssResponse is false when no content-type header is present", () => {
    const res = new Response("", { headers: {} });
    res.headers.delete("content-type");
    expect(isCssResponse(res)).toBe(false);
  });

  test("emptyCustomCssResponse is an empty, uncached stylesheet", async () => {
    const res = emptyCustomCssResponse();
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });
});

describeWithEnv("custom.css handler", { db: true, triggers: true }, () => {
  test("serves an empty text/css body by default", async () => {
    const res = await customCss();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await res.text()).toBe("");
  });

  test("serves the saved custom CSS verbatim", async () => {
    const css = "body { background: rebeccapurple; }";
    await settings.update.customCss(css);
    const res = await customCss();
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toBe(css);
  });

  test("a non-/custom.css path under the prefix is not handled (404)", async () => {
    const res = await handleRequest(mockRequest("/custom.css/extra"));
    expect(res.status).toBe(404);
  });
});
