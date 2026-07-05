// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils";
import {
  expect404ForNonGetStatic,
  expectLongCacheHeaders,
  expectStaticFile,
} from "./static-route-checks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > embed bundles",
  { db: true, triggers: true },
  () => {
    describe("GET /embed.js", () => {
      test("returns JavaScript file", async () => {
        await expectStaticFile(
          "/embed.js",
          "application/javascript; charset=utf-8",
          (js) => expect(js.length).toBeGreaterThan(0),
        );
      });

      test("returns 404 for non-GET requests to /embed.js", async () => {
        await expect404ForNonGetStatic("/embed.js");
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/embed.js");
      });
    });

    describe("GET /iframe-resizer-parent.js", () => {
      test("returns JavaScript file", async () => {
        await expectStaticFile(
          "/iframe-resizer-parent.js",
          "application/javascript; charset=utf-8",
        );
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/iframe-resizer-parent.js");
      });
    });

    describe("GET /iframe-resizer-child.js", () => {
      test("returns JavaScript file", async () => {
        await expectStaticFile(
          "/iframe-resizer-child.js",
          "application/javascript; charset=utf-8",
        );
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/iframe-resizer-child.js");
      });
    });

    // This second "GET /embed.js" block duplicates two checks from the first
    // one above verbatim (same route, same assertions) — that duplication
    // already existed in the pre-split monolith. Preserved as its own test
    // case per the "do not merge distinct test cases" rule; only the
    // boilerplate underneath is shared via the static-route-checks helpers.
    describe("GET /embed.js", () => {
      test("returns JavaScript file", async () => {
        await expectStaticFile(
          "/embed.js",
          "application/javascript; charset=utf-8",
        );
      });

      test("has long cache headers", async () => {
        await expectLongCacheHeaders("/embed.js");
      });
    });
  },
);
