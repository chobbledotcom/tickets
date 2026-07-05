// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { awaitTestRequest, describeWithEnv, mockRequest } from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > embed bundles",
  { db: true, triggers: true },
  () => {
    describe("GET /embed.js", () => {
      test("returns JavaScript file", async () => {
        const response = await handleRequest(mockRequest("/embed.js"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/javascript; charset=utf-8",
        );
        const js = await response.text();
        expect(js.length).toBeGreaterThan(0);
      });

      test("returns 404 for non-GET requests to /embed.js", async () => {
        const response = await awaitTestRequest("/embed.js", {
          data: {},
          method: "POST",
        });
        expect(response.status).toBe(404);
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/embed.js"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /iframe-resizer-parent.js", () => {
      test("returns JavaScript file", async () => {
        const response = await handleRequest(
          mockRequest("/iframe-resizer-parent.js"),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/javascript; charset=utf-8",
        );
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(
          mockRequest("/iframe-resizer-parent.js"),
        );
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /iframe-resizer-child.js", () => {
      test("returns JavaScript file", async () => {
        const response = await handleRequest(
          mockRequest("/iframe-resizer-child.js"),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/javascript; charset=utf-8",
        );
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(
          mockRequest("/iframe-resizer-child.js"),
        );
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /embed.js", () => {
      test("returns JavaScript file", async () => {
        const response = await handleRequest(mockRequest("/embed.js"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/javascript; charset=utf-8",
        );
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/embed.js"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });
  },
);
