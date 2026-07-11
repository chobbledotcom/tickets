/**
 * The shared production handler (`src/serve-app.ts`): lazy one-time boot, the
 * unhandled-error 503 guard, the production N+1 notify-only mode, and the dev
 * entry's port resolution.
 *
 * `initialize` is memoized at module level (`once`), so the order here is
 * load-bearing: the failing-boot case must run BEFORE the first successful
 * boot — a thrown boot check is not memoized, which is exactly what the first
 * test proves — and every later test reuses the one successful boot.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  N_PLUS_ONE_THRESHOLD,
  runWithQueryLogContext,
  trackQuery,
} from "#shared/db/query-log.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { devServerPort, serveHandler } from "#src/serve-app.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { withExpectedError } from "#test-utils/mocks.ts";

const request = (path: string): Request =>
  new Request(`http://localhost${path}`, { headers: { host: "localhost" } });

describeWithEnv("serve-app", { db: true }, () => {
  describe("serveHandler", () => {
    test("a failing boot check returns 503 and does not poison later boots", async () => {
      // MAIN_INSTANCE_KEY must be unset or ≥32 bytes; a short one fails the
      // boot checks inside the handler, which must answer with the generic
      // temporary-error page rather than crash the isolate.
      const restore = setTestEnv({ MAIN_INSTANCE_KEY: "too-short" });
      try {
        await withExpectedError(async () => {
          const response = await serveHandler(request("/health"));
          expect(response.status).toBe(503);
        });
      } finally {
        restore();
      }
    });

    test("boots once, logs the start, and serves requests", async () => {
      setSuppressDebugLogs(false);
      const logSpy = stub(console, "debug");
      try {
        const first = await serveHandler(request("/health"));
        expect(first.status).toBe(200);
        expect(await first.text()).toBe("Up :)");

        const second = await serveHandler(request("/health"));
        expect(second.status).toBe(200);

        // One boot for both requests — and the failed boot above was retried
        // rather than memoized. The line carries how long the isolate took
        // to boot, e.g. "App started (10ms)".
        const bootLogs = logSpy.calls.filter((call) =>
          call.args.some(
            (arg) =>
              String(arg).includes("Setup") &&
              /App started \(\d+ms\)/.test(String(arg)),
          ),
        );
        expect(bootLogs.length).toBe(1);
      } finally {
        logSpy.restore();
        setSuppressDebugLogs(true);
      }
    });

    test("boot puts the N+1 guard into notify-only mode", async () => {
      await serveHandler(request("/health"));
      // Crossing the guard threshold after a production boot must REPORT, not
      // throw — a real request is never killed by the guard (dev/test default
      // is to throw, so a false here fails loudly).
      const errorSpy = stub(console, "error");
      try {
        await runWithQueryLogContext(async () => {
          for (let i = 0; i < N_PLUS_ONE_THRESHOLD + 1; i++) {
            await trackQuery("SELECT 1", () => Promise.resolve("ok"));
          }
        });
        // Let the fire-and-forget dynamic import + logError settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const reported = errorSpy.calls.some((call) =>
          call.args.some((arg) => String(arg).includes("N+1 query detected")),
        );
        expect(reported).toBe(true);
      } finally {
        errorSpy.restore();
      }
    });
  });

  describe("devServerPort", () => {
    test("uses PORT when set", () => {
      const restore = setTestEnv({ PORT: "8080" });
      try {
        expect(devServerPort()).toBe(8080);
      } finally {
        restore();
      }
    });

    test("defaults to 3000 when PORT is unset", () => {
      const restore = setTestEnv({ PORT: undefined });
      try {
        expect(devServerPort()).toBe(3000);
      } finally {
        restore();
      }
    });
  });
});
