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
import { hmacHash } from "#crypto/hashing.ts";
import { queryAll } from "#db/client.ts";
import { N_PLUS_ONE_THRESHOLD, trackSql } from "#db/query-log.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import {
  bunnyServeHandler,
  denoServeHandler,
  devServerPort,
} from "#src/serve-app.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { serveFromBunny } from "#test-utils/entry.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockAdminLoginRequest, withExpectedError } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import {
  expectScheduledResponse,
  scheduledAuthorization,
  TEST_SCHEDULED_KEY,
} from "#test-utils/scheduled.ts";
import { expectTemporaryError } from "#test-utils/temporary-error.ts";

const request = (path: string): Request =>
  new Request(`http://localhost${path}`, {
    headers: { host: "localhost" },
  });

describeWithEnv("serve-app", { db: true }, () => {
  describe("bunnyServeHandler", () => {
    test("rejects an unset scheduled endpoint before broken boot and Sentry", async () => {
      using _env = withEnv({
        MAIN_INSTANCE_KEY: "too-short",
        SCHEDULED_TASK_KEY: undefined,
        SENTRY_URL: "https://abc123@bugs.example.test/2",
      });
      using fetchStub = stubFetch(new Error("Sentry must not start"));

      const response = await serveFromBunny(
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

      const response = await serveFromBunny(request);

      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expectScheduledResponse(response, 401);
      expect(request.bodyUsed).toBe(false);
    });

    test("hides every non-POST scheduled method before boot", async () => {
      using _env = withEnv({
        MAIN_INSTANCE_KEY: "too-short",
        SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      });
      const response = await serveFromBunny(
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
        const response = await serveFromBunny(
          new Request("https://scheduled-site.example/scheduled", {
            headers: scheduledAuthorization(),
            method: "POST",
          }),
        );
        await expectScheduledResponse(response, 503);
        expect(getEffectiveDomain()).toBe("scheduled-site.example");
      });
    });

    for (const method of ["GET", "HEAD"]) {
      test(`refreshes ${method} after a failed boot`, async () => {
        using _env = withEnv({ MAIN_INSTANCE_KEY: "too-short" });
        await withExpectedError(async () => {
          const response = await serveFromBunny(
            new Request("http://localhost/health", { method }),
          );
          await expectTemporaryError(true)(response);
        });
      });
    }

    test("does not refresh a POST when the outer handler catches an error", async () => {
      using _env = withEnv({ MAIN_INSTANCE_KEY: "too-short" });
      await withExpectedError(async () => {
        const response = await serveFromBunny(
          new Request("http://localhost/admin/listing", { method: "POST" }),
        );
        await expectTemporaryError(false)(response);
      });
    });

    test("boots once, logs the start, and serves requests", async () => {
      setSuppressDebugLogs(false);
      const logSpy = stub(console, "debug");
      try {
        const first = await serveFromBunny(request("/health"));
        expect(first.status).toBe(200);
        expect(await first.text()).toBe("Up :)");

        const second = await serveFromBunny(request("/health"));
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
      await serveFromBunny(request("/health"));
      // Crossing the guard threshold after a production boot must REPORT, not
      // throw — a real request is never killed by the guard (dev/test default
      // is to throw, so a false here fails loudly).
      const errorSpy = stub(console, "error");
      try {
        await withRequestContext(async () => {
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

  describe("client IP", () => {
    const wrongLogin = async (): Promise<Request> =>
      await mockAdminLoginRequest({ password: "wrong", username: "nobody" });

    const flashOf = (response: Response): string =>
      decodeURIComponent(response.headers.get("set-cookie") ?? "");

    const entries: Record<
      string,
      (request: Request, ip: string) => Promise<Response>
    > = {
      bunny: serveFromBunny,
      deno: (request, ip) =>
        denoServeHandler(request, {
          completed: Promise.resolve(),
          remoteAddr: { hostname: ip, port: 51000, transport: "tcp" },
        }),
    };

    for (const [name, serveFrom] of Object.entries(entries)) {
      test(`${name} entry keeps one login limit for each client IP`, async () => {
        for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt++) {
          await serveFrom(await wrongLogin(), "192.0.2.1");
        }

        const other = await serveFrom(await wrongLogin(), "192.0.2.2");
        const locked = await serveFrom(await wrongLogin(), "192.0.2.1");

        expect(flashOf(other)).toContain("Username or password was wrong");
        expect(flashOf(locked)).toContain("Too many login attempts");
        const rows = await queryAll<{ attempts: number; ip: string }>(
          "SELECT ip, attempts FROM login_attempts ORDER BY attempts",
        );
        expect(rows).toEqual([
          { attempts: 1, ip: await hmacHash("192.0.2.2") },
          { attempts: MAX_LOGIN_ATTEMPTS, ip: await hmacHash("192.0.2.1") },
        ]);
      });
    }

    test("bunny entry throws on a request with no x-real-ip header", () => {
      expect(() =>
        bunnyServeHandler(new Request("http://localhost/health")),
      ).toThrow("Bunny request has no x-real-ip header");
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
