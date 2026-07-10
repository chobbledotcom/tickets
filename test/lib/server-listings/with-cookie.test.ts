// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withCookie } from "#routes/response.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

describeWithEnv("server listings > withCookie", { db: true }, () => {
  describe("withCookie", () => {
    test("adds a cookie to a response without existing cookies", async () => {
      const response = new Response("body", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });

    test("preserves existing set-cookie headers when adding another", async () => {
      const headers = new Headers();
      headers.append("set-cookie", "first=one; Path=/");
      const response = new Response("body", { headers, status: 200 });
      const result = await withCookie(response, "second=two; Path=/");
      const cookies = result.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies).toContain("first=one; Path=/");
      expect(cookies).toContain("second=two; Path=/");
    });

    test("preserves response status", async () => {
      const response = new Response("body", { status: 201 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(201);
    });

    test("preserves text response body", async () => {
      const response = new Response("hello world", { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(await result.text()).toBe("hello world");
    });

    test("preserves binary response body", async () => {
      const bytes = new Uint8Array([0, 1, 2, 128, 255]);
      const response = new Response(bytes, { status: 200 });
      const result = await withCookie(response, "session=abc; Path=/");
      const body = new Uint8Array(await result.arrayBuffer());
      expect(body.length).toBe(5);
      expect(body[0]).toBe(0);
      expect(body[3]).toBe(128);
      expect(body[4]).toBe(255);
    });

    test("handles null body response", async () => {
      const response = new Response(null, { status: 204 });
      const result = await withCookie(response, "session=abc; Path=/");
      expect(result.status).toBe(204);
      expect(result.headers.get("set-cookie")).toBe("session=abc; Path=/");
    });
  });
});
