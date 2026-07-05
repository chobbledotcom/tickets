// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { awaitTestRequest, describeWithEnv, mockRequest } from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > static assets",
  { db: true, triggers: true },
  () => {
    describe("GET /robots.txt", () => {
      test("returns plain text robots.txt", async () => {
        const response = await handleRequest(mockRequest("/robots.txt"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "text/plain; charset=utf-8",
        );
      });

      test("allows crawlers on /listings/ but disallows everything else", async () => {
        const response = await handleRequest(mockRequest("/robots.txt"));
        const body = await response.text();
        expect(body).toContain("User-agent: *");
        expect(body).toContain("Allow: /listings/");
        expect(body).toContain("Disallow: /");
      });

      test("returns 404 for non-GET requests to /robots.txt", async () => {
        const response = await awaitTestRequest("/robots.txt", {
          data: {},
          method: "POST",
        });
        expect(response.status).toBe(404);
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/robots.txt"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /favicon.ico", () => {
      test("returns SVG favicon", async () => {
        const response = await handleRequest(mockRequest("/favicon.ico"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        const svg = await response.text();
        expect(svg).toContain("<svg");
        expect(svg).toContain("viewBox");
      });

      test("returns 404 for non-GET requests to /favicon.ico", async () => {
        const response = await awaitTestRequest("/favicon.ico", {
          data: {},
          method: "POST",
        });
        expect(response.status).toBe(404);
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/favicon.ico"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /icons.svg", () => {
      test("returns SVG icon sprite", async () => {
        const response = await handleRequest(mockRequest("/icons.svg"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/svg+xml");
        const svg = await response.text();
        expect(svg).toContain("<svg");
        expect(svg).toContain('id="plus"');
      });

      test("returns 404 for non-GET requests to /icons.svg", async () => {
        const response = await awaitTestRequest("/icons.svg", {
          data: {},
          method: "POST",
        });
        expect(response.status).toBe(404);
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/icons.svg"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /style.css", () => {
      test("returns CSS stylesheet", async () => {
        const response = await handleRequest(mockRequest("/style.css"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "text/css; charset=utf-8",
        );
        const css = await response.text();
        expect(css).toContain(":root");
        expect(css).toContain("--color-link");
      });

      test("returns 404 for non-GET requests to /style.css", async () => {
        const response = await awaitTestRequest("/style.css", {
          data: {},
          method: "POST",
        });
        expect(response.status).toBe(404);
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/style.css"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /admin.js", () => {
      test("returns JavaScript file", async () => {
        const response = await handleRequest(mockRequest("/admin.js"));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/javascript; charset=utf-8",
        );
        const js = await response.text();
        expect(js).toContain("data-select-on-click");
        expect(js).toContain("data-nav-select");
      });

      test("bundles every admin page behavior", async () => {
        // One distinctive runtime string per module wired up in admin.ts, in
        // its wiring order. A missing marker means the bundle dropped that
        // module — i.e. its init call fell out of the admin entry point (the
        // bundler tree-shakes the whole module away with it).
        const moduleMarkers = [
          "[data-select-on-click]",
          "data-nav-select",
          "[data-availability-checker]",
          "[data-day-count-label]",
          "[data-multi-booking-slug]",
          "[data-fill-default]",
          "closes_at",
          "[data-scroll-into-view]",
          "[data-checkout-popup]",
          "[data-payment-result]",
          "/admin/settings/stripe/test",
          "[data-qr-refresh]",
          "[data-running-total-output]",
          "char-counter-warn",
          "/admin/markdown-preview",
          "/markdown-editor.js",
          "#manual-checkin-input",
          ":not([data-manual-checkin])",
          ".custom-question[data-listing-ids]",
          "data-child-hint",
          "data-child-dates",
          ".daily-date-field",
          "[data-duplicate-preview]",
          "duration-warning-confirm",
          "Please select at least one ticket",
        ];
        const response = await handleRequest(mockRequest("/admin.js"));
        const js = await response.text();
        for (const marker of moduleMarkers) {
          expect(js).toContain(marker);
        }
      });

      test("returns 404 for non-GET requests to /admin.js", async () => {
        const response = await awaitTestRequest("/admin.js", {
          data: {},
          method: "POST",
        });
        expect(response.status).toBe(404);
      });

      test("has long cache headers", async () => {
        const response = await handleRequest(mockRequest("/admin.js"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      });
    });

    describe("GET /scanner.js and /contact.js", () => {
      test("serves each standalone client bundle as JavaScript", async () => {
        for (const path of ["/scanner.js", "/contact.js"]) {
          const response = await handleRequest(mockRequest(path));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(
            "application/javascript; charset=utf-8",
          );
        }
      });
    });

    describe("GET /markdown-editor.js", () => {
      test("serves the rich editor bundle with long cache headers", async () => {
        const response = await handleRequest(
          mockRequest("/markdown-editor.js"),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(
          "application/javascript; charset=utf-8",
        );
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
        expect(await response.text()).toContain("md-editor");
      });
    });
  },
);
