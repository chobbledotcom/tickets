// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  expect404ForNonGetStatic,
  expectLongCacheHeaders,
  expectStaticFile,
} from "#test/lib/server-public/static-route-checks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > static assets",
  { db: true, triggers: true },
  () => {
    describe("GET /robots.txt", () => {
      test("returns plain text robots.txt", async () => {
        await expectStaticFile("/robots.txt", "text/plain; charset=utf-8");
      });

      test("allows crawlers on /listings/ but disallows everything else", async () => {
        const response = await handleRequest(mockRequest("/robots.txt"));
        const body = await response.text();
        expect(body).toContain("User-agent: *");
        expect(body).toContain("Allow: /listings/");
        expect(body).toContain("Disallow: /");
      });

      test("returns 404 for non-GET requests to /robots.txt", async () => {
        await expect404ForNonGetStatic("/robots.txt");
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/robots.txt");
      });
    });

    describe("GET /favicon.ico", () => {
      test("returns SVG favicon", async () => {
        await expectStaticFile("/favicon.ico", "image/svg+xml", (svg) => {
          expect(svg).toContain("<svg");
          expect(svg).toContain("viewBox");
        });
      });

      test("returns 404 for non-GET requests to /favicon.ico", async () => {
        await expect404ForNonGetStatic("/favicon.ico");
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/favicon.ico");
      });
    });

    describe("GET /icons.svg", () => {
      test("returns SVG icon sprite", async () => {
        await expectStaticFile("/icons.svg", "image/svg+xml", (svg) => {
          expect(svg).toContain("<svg");
          expect(svg).toContain('id="plus"');
        });
      });

      test("returns 404 for non-GET requests to /icons.svg", async () => {
        await expect404ForNonGetStatic("/icons.svg");
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/icons.svg");
      });
    });

    describe("GET /style.css", () => {
      test("returns CSS stylesheet", async () => {
        await expectStaticFile(
          "/style.css",
          "text/css; charset=utf-8",
          (css) => {
            expect(css).toContain(":root");
            expect(css).toContain("--color-link");
          },
        );
      });

      test("returns 404 for non-GET requests to /style.css", async () => {
        await expect404ForNonGetStatic("/style.css");
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/style.css");
      });
    });

    describe("GET /admin.js", () => {
      test("returns JavaScript file", async () => {
        await expectStaticFile(
          "/admin.js",
          "application/javascript; charset=utf-8",
          (js) => {
            expect(js).toContain("data-select-on-click");
            expect(js).toContain("data-nav-select");
          },
        );
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
          "/logistics-map.js",
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
        await expect404ForNonGetStatic("/admin.js");
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/admin.js");
      });
    });

    describe("GET /scanner.js and /contact.js", () => {
      test("serves each standalone client bundle as JavaScript", async () => {
        for (const path of ["/scanner.js", "/contact.js"]) {
          await expectStaticFile(path, "application/javascript; charset=utf-8");
        }
      });
    });

    describe("GET /markdown-editor.js", () => {
      test("serves the rich editor bundle with long cache headers", async () => {
        await expectStaticFile(
          "/markdown-editor.js",
          "application/javascript; charset=utf-8",
          (js) => expect(js).toContain("md-editor"),
        );
        await expectLongCacheHeaders("/markdown-editor.js");
      });
    });

    describe("GET /logistics-map.js and /logistics-map.css", () => {
      test("serves the map bundle with long cache headers", async () => {
        await expectStaticFile(
          "/logistics-map.js",
          "application/javascript; charset=utf-8",
          (js) => expect(js).toContain("logistics-map-pin"),
        );
        await expectLongCacheHeaders("/logistics-map.js");
      });

      test("serves Leaflet's stylesheet", async () => {
        await expectStaticFile(
          "/logistics-map.css",
          "text/css; charset=utf-8",
          (css) => expect(css).toContain(".leaflet-pane"),
        );
      });
    });
  },
);
