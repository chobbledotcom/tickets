import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getLocale } from "#i18n";
import {
  requestScopedHandler,
  runWithRequestScopes,
} from "#routes/request-scopes.ts";
import { getRequestClientIp } from "#shared/client-context.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  countExternalSubrequest,
} from "#shared/subrequest-budget.ts";
import {
  markAdminFooter,
  renderAdminFooter,
  runWithAdminFooterContext,
} from "#templates/admin/footer.tsx";

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

  test("keeps an ambient admin footer marker out of a request", async () => {
    await runWithAdminFooterContext(async () => {
      markAdminFooter("owner");

      const response = await runWithRequestScopes(
        new Request("https://example.com/public"),
        undefined,
        () => Promise.resolve(new Response(renderAdminFooter())),
      );

      expect(await response.text()).toBe("");
    });
    expect(renderAdminFooter()).toBe("");
  });

  test("keeps queued work inside the request subrequest budget", async () => {
    let blocked = "";
    // Pending work accepts promises in production. This lazy thenable makes its
    // work begin only when the request scope drains the queue.
    const queuedWork = {
      // biome-ignore lint/suspicious/noThenProperty: the regression requires work that starts during promise assimilation
      then: (resolve: () => void): void => {
        try {
          for (let call = 0; call <= BUNNY_SUBREQUEST_LIMIT; call += 1) {
            countExternalSubrequest("queued test work");
          }
        } catch (error) {
          blocked = String(error);
        }
        resolve();
      },
    } as unknown as Promise<unknown>;

    await runWithRequestScopes(
      new Request("https://example.com/queued"),
      undefined,
      () => {
        addPendingWork(queuedWork);
        return Promise.resolve(new Response());
      },
    );

    expect(blocked).toContain(
      `Subrequest allowance exceeded: 0 database + ${BUNNY_SUBREQUEST_LIMIT + 1} external calls`,
    );
  });
});
