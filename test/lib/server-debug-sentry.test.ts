import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { resetSentry } from "#test-utils/sentry.ts";
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

const sendAcceptedSentryTest = async (
  env: Record<string, string> = {},
): Promise<{ requests: number; response: Response }> => {
  using _env = withEnv({ SENTRY_URL: SENTRY_DSN, ...env });
  using fetchStub = stubFetch(new Response(null, { status: 200 }));
  try {
    const { response } = await adminFormPost("/admin/debug/sentry");
    return { requests: fetchStub.calls.length, response };
  } finally {
    resetSentry();
  }
};

describeWithEnv("server (admin Sentry test)", { db: true }, () => {
  testRequiresAuth("/admin/debug/sentry", { method: "POST" });

  test("shows an inline test form when Sentry is configured", async () => {
    using _env = withEnv({ SENTRY_URL: SENTRY_DSN });
    const response = await adminGet("/admin/debug");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('action="/admin/debug/sentry"');
    expect(html).toContain('class="inline"');
    expect(html).toContain('id="debug-sentry-test"');
    expect(html).toContain(">Test Sentry</button>");
  });

  test("hides the test form when Sentry is not configured", async () => {
    using _env = withEnv({ SENTRY_URL: undefined });
    const html = await (await adminGet("/admin/debug")).text();
    expect(html).toContain("Sentry URL");
    expect(html).not.toContain('action="/admin/debug/sentry"');
  });

  test("sends a tagged test error and confirms delivery", async () => {
    const { requests, response } = await sendAcceptedSentryTest();
    expectDebugRedirect(response);
    expectFlash(response, "Sentry test sent.");
    expect(requests).toBe(1);
  });

  test("sends the diagnostic while the site is read-only", async () => {
    const { requests, response } = await sendAcceptedSentryTest({
      READ_ONLY_FROM: "2000-01-01T00:00:00Z",
    });
    expectDebugRedirect(response);
    expectFlash(response, "Sentry test sent.");
    expect(requests).toBe(1);
  });

  test("reports when Sentry is not configured", async () => {
    using _env = withEnv({ SENTRY_URL: undefined });
    try {
      const { response } = await adminFormPost("/admin/debug/sentry");
      expectDebugRedirect(response);
      expectFlash(
        response,
        "Sentry could not send the test. Check SENTRY_URL and try again.",
        false,
      );
    } finally {
      resetSentry();
    }
  });

  test("reports when Sentry rejects the test event", async () => {
    using _env = withEnv({ SENTRY_URL: SENTRY_DSN });
    using fetchStub = stubFetch(new Response(null, { status: 403 }));
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
      resetSentry();
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
