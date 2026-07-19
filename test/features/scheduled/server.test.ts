import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { initSentry } from "#shared/sentry.ts";
import { serveHandler } from "#src/serve-app.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  expectScheduledResponse,
  scheduledAuthorization,
  TEST_SCHEDULED_KEY,
  TEST_SCHEDULED_NEXT_KEY,
} from "#test-utils/scheduled.ts";
import { resetSentry } from "#test-utils/sentry.ts";

const scheduled = (key = TEST_SCHEDULED_KEY): Promise<Response> =>
  serveHandler(
    mockRequest("/scheduled", {
      headers: scheduledAuthorization(key),
      method: "POST",
    }),
  );

describeWithEnv(
  "server (scheduled maintenance)",
  {
    db: true,
    env: {
      SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
      SCHEDULED_TASK_KEY_NEXT: TEST_SCHEDULED_NEXT_KEY,
    },
  },
  () => {
    const errors = setupErrorSpy();

    test("runs authenticated local maintenance through the production handler", async () => {
      await expectScheduledResponse(await scheduled(), 204);
    });

    test("accepts the next key during rotation", async () => {
      await expectScheduledResponse(
        await scheduled(TEST_SCHEDULED_NEXT_KEY),
        204,
      );
    });

    test("returns 503 until site setup is complete", async () => {
      using _env = withEnv({
        SENTRY_URL: "https://scheduled@bugs.example.test/2",
      });
      using fetchStub = stubFetch(new Response("{}", { status: 200 }));
      await initSentry();
      try {
        await settings.setRaw("setup_complete", "false");
        settings.setup.clearCache();
        settings.invalidateCache();

        await expectScheduledResponse(await scheduled(), 503);
        expect(errors.contains("scheduled maintenance failed")).toBe(true);
        const [, options] = fetchStub.calls[0]!.args as [string, RequestInit];
        const body =
          typeof options.body === "string"
            ? options.body
            : new TextDecoder().decode(options.body as Uint8Array);
        expect(body).toContain(
          "Scheduled maintenance requires completed setup",
        );
      } finally {
        resetSentry();
      }
    });

    test("does not read an authenticated request body", async () => {
      const request = mockRequest("/scheduled", {
        body: "ignored",
        headers: scheduledAuthorization(),
        method: "POST",
      });
      await expectScheduledResponse(await serveHandler(request), 204);
      expect(request.bodyUsed).toBe(false);
    });

    test("returns a bearer challenge for missing credentials", async () => {
      const response = await serveHandler(
        mockRequest("/scheduled", { method: "POST" }),
      );
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expectScheduledResponse(response, 401);
    });

    test("returns a bearer challenge for malformed credentials", async () => {
      const response = await serveHandler(
        mockRequest("/scheduled", {
          headers: { authorization: `Basic ${TEST_SCHEDULED_KEY}` },
          method: "POST",
        }),
      );
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expectScheduledResponse(response, 401);
    });

    test("returns a bearer challenge for the wrong key", async () => {
      const response = await scheduled("wrong");
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      await expectScheduledResponse(response, 401);
    });

    test("does not expose the endpoint through the normal app router", async () => {
      const response = await handleRequest(
        mockRequest("/scheduled", {
          headers: {
            ...scheduledAuthorization(),
            "content-type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("does not make outbound scheduler requests on a builder", async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = () => {
        calls += 1;
        return Promise.reject(new Error("unexpected scheduler fetch"));
      };
      try {
        await expectScheduledResponse(await scheduled(), 204);
        expect(calls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  },
);

describeWithEnv(
  "server (scheduled maintenance in read-only mode)",
  {
    db: true,
    env: {
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
    },
  },
  () => {
    test("permits an authenticated local run", async () => {
      await expectScheduledResponse(await scheduled(), 204);
    });
  },
);
