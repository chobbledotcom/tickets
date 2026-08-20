// test-groups: run-alone
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
  trackSql,
} from "#db/query-log.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { devServerPort, serveHandler } from "#src/serve-app.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { withExpectedError } from "#test-utils/mocks.ts";
import {
  expectScheduledResponse,
  scheduledAuthorization,
  TEST_SCHEDULED_KEY,
} from "#test-utils/scheduled.ts";

const request = (path: string): Request =>
  new Request(`http://localhost${path}`, { headers: { host: "localhost" } });

describeWithEnv("serve-app", { db: true }, () => {
  describe("serveHandler", () => {
    test("rejects an unset scheduled endpoint before broken boot and Sentry", async () => {
      using _env = withEnv({
        MAIN_INSTANCE_KEY: "too-short",
        SCHEDULED_TASK_KEY: undefined,
        SENTRY_URL: "https://abc123@bugs.example.test/2",
      });
      using fetchStub = stubFetch(new Error("Sentry must not start"));

      const response = await serveHandler(
        new Request("http://localhost/scheduled", { method: "POST" }),
      );

      await expectScheduledResponse(response, 404);
      expect(fetchStub.calls.length).toBe(0);
    });

    test("rejects a wrong scheduled key without reading the body", async () => {
      using _env = withEnv({
        MAIN_INSTANCE_KEY: "too-short",
        SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      });
      const request = new Request("http://localhost/scheduled", {
        body: "caller-selected work",
        headers: {
          ...scheduledAuthorization("wrong"),
          "content-type": "application/json",
        },
        method: "POST",
      });

      const response = await serveHandler(request);

      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expectScheduledResponse(response, 401);
      expect(request.bodyUsed).toBe(false);
    });

    test("hides every non-POST scheduled method before boot", async () => {
      using _env = withEnv({
        MAIN_INSTANCE_KEY: "too-short",
        SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      });
      const response = await serveHandler(
        new Request("http://localhost/scheduled", {
          headers: scheduledAuthorization(),
          method: "GET",
        }),
      );

      await expectScheduledResponse(response, 404);
    });

    test("returns an empty scheduled 503 when authorized boot fails", async () => {
      using _env = withEnv({
        MAIN_INSTANCE_KEY: "too-short",
        SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      });
      await withExpectedError(async () => {
        const response = await serveHandler(
          new Request("https://scheduled-site.example/scheduled", {
            headers: scheduledAuthorization(),
            method: "POST",
          }),
        );
        await expectScheduledResponse(response, 503);
        expect(getEffectiveDomain()).toBe("scheduled-site.example");
      });
    });

    test("a failing boot check returns 503 and does not poison later boots", async () => {
      // MAIN_INSTANCE_KEY must be unset or ≥32 bytes; a short one fails the
      // boot checks inside the handler, which must answer with the generic
      // temporary-error page rather than crash the isolate.
      using _env = withEnv({ MAIN_INSTANCE_KEY: "too-short" });
      await withExpectedError(async () => {
        const response = await serveHandler(request("/health"));
        expect(response.status).toBe(503);
      });
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
        // rather than memoized. The phases account for the whole boot time.
        const bootLogs = logSpy.calls.filter((call) =>
          call.args.some(
            (arg) =>
              String(arg).includes("Setup") &&
              String(arg).includes("App started"),
          ),
        );
        expect(bootLogs.length).toBe(1);
        const message = bootLogs[0]?.args.map(String).join(" ");
        const match =
          /App started \((?<total>\d+)ms: runtime \+ bundle load (?<runtimeLoad>\d+)ms, request wait (?<wait>\d+)ms, boot setup (?<boot>\d+)ms, Sentry (?<sentry>\d+)ms\)/.exec(
            message ?? "",
          );
        if (!match?.groups) throw new Error(`Invalid boot log: ${message}`);
        const groups = match.groups;
        const total = Number(groups.total);
        const phases = ["runtimeLoad", "wait", "boot", "sentry"].map((name) =>
          Number(groups[name]),
        );
        expect(phases.reduce((sum, duration) => sum + duration, 0)).toBe(total);
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
            await trackSql("SELECT 1", () => Promise.resolve("ok"));
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
      using _env = withEnv({ PORT: "8080" });
      expect(devServerPort()).toBe(8080);
    });

    test("defaults to 3000 when PORT is unset", () => {
      using _env = withEnv({ PORT: undefined });
      expect(devServerPort()).toBe(3000);
    });
  });
});
