import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetSentryForTest } from "#shared/sentry.ts";
import {
  expectFlash,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";

const SENTRY_DSN = "https://abc123@bugs.example.test/2";

const expectDebugRedirect = (response: Response): void => {
  expectRedirect(response, "/admin/debug");
  expect(response.headers.get("location")).toMatch(
    /^\/admin\/debug\?flash=[^&]+&form=debug-sentry-test#debug-sentry-test$/,
  );
};

describeWithEnv("server (admin Sentry test)", { db: true }, () => {
  testRequiresAuth("/admin/debug/sentry", { method: "POST" });

  test("shows an inline test form when Sentry is configured", async () => {
    const restoreEnv = setTestEnv({ SENTRY_URL: SENTRY_DSN });
    try {
      const response = await adminGet("/admin/debug");
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('action="/admin/debug/sentry"');
      expect(html).toContain('class="inline"');
      expect(html).toContain('id="debug-sentry-test"');
      expect(html).toContain(">Test Sentry</button>");
    } finally {
      restoreEnv();
    }
  });

  test("hides the test form when Sentry is not configured", async () => {
    const restoreEnv = setTestEnv({ SENTRY_URL: undefined });
    try {
      const html = await (await adminGet("/admin/debug")).text();
      expect(html).toContain("Sentry URL");
      expect(html).not.toContain('action="/admin/debug/sentry"');
    } finally {
      restoreEnv();
    }
  });

  test("sends a tagged test error and confirms delivery", async () => {
    const restoreEnv = setTestEnv({ SENTRY_URL: SENTRY_DSN });
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    try {
      const { response } = await adminFormPost("/admin/debug/sentry");
      expectDebugRedirect(response);
      expectFlash(response, "Sentry test sent.");
      expect(fetchStub.calls.length).toBe(1);
    } finally {
      fetchStub.restore();
      restoreEnv();
      resetSentryForTest();
    }
  });

  test("reports when Sentry is not configured", async () => {
    const restoreEnv = setTestEnv({ SENTRY_URL: undefined });
    try {
      const { response } = await adminFormPost("/admin/debug/sentry");
      expectDebugRedirect(response);
      expectFlash(
        response,
        "Sentry could not send the test. Check SENTRY_URL and try again.",
        false,
      );
    } finally {
      restoreEnv();
      resetSentryForTest();
    }
  });

  test("reports when Sentry rejects the test event", async () => {
    const restoreEnv = setTestEnv({ SENTRY_URL: SENTRY_DSN });
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    try {
      const { response } = await adminFormPost("/admin/debug/sentry");
      expectDebugRedirect(response);
      expectFlash(
        response,
        "Sentry could not send the test. Check SENTRY_URL and try again.",
        false,
      );
      expect(fetchStub.calls.length).toBe(1);
    } finally {
      fetchStub.restore();
      restoreEnv();
      resetSentryForTest();
    }
  });

  test("forbids a manager from viewing the debug page", async () => {
    const response = await handleRequest(
      new Request("http://localhost/admin/debug", {
        headers: {
          cookie: await createTestManagerSession("mgr-debug-page"),
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  test("forbids a manager from sending a Sentry test", async () => {
    const response = await handleRequest(
      mockFormRequest(
        "/admin/debug/sentry",
        { csrf_token: "mgr-csrf" },
        await createTestManagerSession("mgr-sentry-test"),
      ),
    );
    expect(response.status).toBe(403);
  });
});
