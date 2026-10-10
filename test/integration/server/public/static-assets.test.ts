// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  expect404ForNonGetStatic,
  expectLongCacheHeaders,
  expectStaticFile,
} from "#test-utils/public/static-route-checks.ts";
import { disablePublicSite, enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** The compiled stylesheet is one media query per topic, compressed, with flat
 * rules. Read it the way a print stylesheet resolves: take the `@media print`
 * block, then the declarations of the rule whose selector group names the
 * given selector. Throws when no print rule styles it. */
const printBlockOf = (css: string): string => {
  const start = css.indexOf("@media print");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("Unterminated @media print block");
};

const printStyleOf = (
  css: string,
  selector: string,
): Record<string, string> => {
  const block = printBlockOf(css);
  // Slice off the `@media print {` wrapper; the block's rules are flat.
  const inner = block.slice(block.indexOf("{") + 1, -1);
  for (const rule of inner.split("}")) {
    const brace = rule.indexOf("{");
    if (brace === -1) continue;
    const selectors = rule
      .slice(0, brace)
      .split(",")
      .map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    return Object.fromEntries(
      rule
        .slice(brace + 1)
        .split(";")
        .filter(Boolean)
        .map((declaration) => {
          const colon = declaration.indexOf(":");
          return [
            declaration.slice(0, colon).trim(),
            declaration.slice(colon + 1).trim(),
          ];
        }),
    );
  }
  throw new Error(`No print rule styles ${selector}`);
};

describeWithEnv(
  "server public > static assets",
  { db: true, triggers: true },
  () => {
    describe("GET /robots.txt", () => {
      test("returns plain text robots.txt", async () => {
        await expectStaticFile("/robots.txt", "text/plain; charset=utf-8");
      });

      test("keeps the listings-only body while the public site is off", async () => {
        await disablePublicSite();
        const response = await handleRequest(mockRequest("/robots.txt"));
        expect(await response.text()).toBe(
          "User-agent: *\nAllow: /listings/\nDisallow: /\n",
        );
      });

      test("opens every page once the public site is on", async () => {
        await enablePublicSite();
        try {
          const response = await handleRequest(mockRequest("/robots.txt"));
          expect(await response.text()).toBe("User-agent: *\nAllow: /\n");
        } finally {
          await disablePublicSite();
        }
      });

      test("answers from the database with nothing cached", async () => {
        // The static path serves before a request loads settings, so the
        // handler must read its own key: with the process cache emptied, a
        // body that followed a stale or empty snapshot would say Disallow.
        await enablePublicSite();
        settings.invalidateCache();
        try {
          const response = await handleRequest(mockRequest("/robots.txt"));
          expect(await response.text()).toBe("User-agent: *\nAllow: /\n");
        } finally {
          await disablePublicSite();
          settings.invalidateCache();
        }
      });

      test("names no private path in either state", async () => {
        for (const publicSite of [false, true] as const) {
          if (publicSite) {
            await enablePublicSite();
          } else {
            await disablePublicSite();
          }
          const body = await (
            await handleRequest(mockRequest("/robots.txt"))
          ).text();
          for (const family of [
            "/admin",
            "/api",
            "/checkout",
            "/payment",
            "/webhook",
            "/ticket",
            "/order",
            "/pay",
            "/renew",
            "/join",
            "/unsubscribe",
            "/setup",
            "/login",
          ]) {
            expect(body.includes(family)).toBe(false);
          }
        }
        await disablePublicSite();
      });

      test("returns 404 for non-GET requests to /robots.txt", async () => {
        await expect404ForNonGetStatic("/robots.txt");
      });

      test("caches briefly, because the body follows a setting", async () => {
        const response = await handleRequest(mockRequest("/robots.txt"));
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=300",
        );
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

      test("prints without the site footer or the interface chrome", async () => {
        await expectStaticFile(
          "/style.css",
          "text/css; charset=utf-8",
          (css) => {
            expect(printStyleOf(css, ".site-footer")).toEqual({
              display: "none",
            });
            expect(printStyleOf(css, ".admin-footer")).toEqual({
              display: "none",
            });
            expect(printStyleOf(css, ".admin-nav-group")).toEqual({
              display: "none",
            });
            expect(
              printStyleOf(css, "body:has(.admin-nav-group) main"),
            ).toEqual({ display: "block" });
            expect(printStyleOf(css, ".ticket-card")["box-shadow"]).toBe(
              "none",
            );
            expect(printStyleOf(css, ".ticket-card-qr img")["max-width"]).toBe(
              "8rem",
            );
          },
        );
      });

      test("keeps the print block after the base rules it overrides", async () => {
        await expectStaticFile(
          "/style.css",
          "text/css; charset=utf-8",
          (css) => {
            const printBlock = css.indexOf("@media print");
            // A print rule the base cascade defeats is worse than none: equal
            // specificity, so whichever rule comes later wins. The base
            // ticket-card and admin-footer rules must precede the print block.
            expect(css.indexOf(".ticket-card{")).toBeLessThan(printBlock);
            expect(css.indexOf(".admin-footer{")).toBeLessThan(printBlock);
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
        // bundler tree-shakes the whole module away with it). A marker must be
        // a literal the module keeps: a value it builds per call survives only
        // as the fixed part of its template.
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
          "-test-btn",
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
