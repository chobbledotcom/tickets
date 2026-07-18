import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getLocale } from "#i18n";
import {
  requestScopedHandler,
  runWithRequestScopes,
} from "#routes/request-scopes.ts";
import { getRequestClientIp } from "#shared/client-context.ts";

describe("request scopes", () => {
  test("binds request values while building the response", async () => {
    const request = new Request("https://example.com/path");
    const server = { requestIP: () => ({ address: "203.0.113.9" }) };

    const response = await runWithRequestScopes(request, server, () =>
      Promise.resolve(
        Response.json({ ip: getRequestClientIp(), locale: getLocale() }),
      ),
    );

    expect(await response.json()).toEqual({ ip: "203.0.113.9", locale: "en" });
    expect(getRequestClientIp()).toBe("direct");
  });

  test("passes the request and server through the scoped handler", async () => {
    const request = new Request("https://example.com/scoped");
    const server = { requestIP: () => ({ address: "198.51.100.4" }) };
    const handler = requestScopedHandler((receivedRequest, receivedServer) =>
      Promise.resolve(
        Response.json({
          ip: getRequestClientIp(),
          requestMatches: receivedRequest === request,
          serverMatches: receivedServer === server,
        }),
      ),
    );

    const response = await handler(request, server);

    expect(await response.json()).toEqual({
      ip: "198.51.100.4",
      requestMatches: true,
      serverMatches: true,
    });
  });
});
