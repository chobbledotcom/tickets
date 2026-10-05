import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getLocale } from "#i18n";
import {
  requestScopedHandler,
  runWithRequestScopes,
} from "#routes/request-scopes.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { getRequestClientIp } from "#shared/request-context.ts";
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
    const response = await runWithRequestScopes(request, "203.0.113.9", () =>
      Promise.resolve(
        Response.json({ ip: getRequestClientIp(), locale: getLocale() }),
      ),
    );

    expect(await response.json()).toEqual({ ip: "203.0.113.9", locale: "en" });
    expect(getRequestClientIp()).toBe("direct");
  });

  test("binds the client IP around the scoped handler", async () => {
    const request = new Request("https://example.com/scoped");
    const handler = requestScopedHandler((receivedRequest) =>
      Promise.resolve(
        Response.json({
          ip: getRequestClientIp(),
          requestMatches: receivedRequest === request,
        }),
      ),
    );

    const scoped = await handler(request, "198.51.100.4");
    const inProcess = await handler(request);

    expect(await scoped.json()).toEqual({
      ip: "198.51.100.4",
      requestMatches: true,
    });
    expect(await inProcess.json()).toEqual({
      ip: "direct",
      requestMatches: true,
    });
  });

  test("keeps an ambient admin footer marker out of a request", async () => {
    await runWithAdminFooterContext(async () => {
      markAdminFooter("owner");

      const response = await runWithRequestScopes(
        new Request("https://example.com/public"),
        "direct",
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
      "direct",
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
