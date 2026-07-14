import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import {
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_EVENTS_VERSION,
} from "#shared/stripe-webhook-events.ts";
import { reconcileStoredStripeWebhook } from "#shared/stripe-webhook-reconcile.ts";
import {
  installUrlHandler,
  mockRequestWithHost,
  urlFromFetchInput,
  withFetchMock,
} from "#test-utils/mocks.ts";
import { describeStripe } from "./harness.ts";

const WEBHOOK_URL = "https://tickets.example/payment/webhook";

type StripeRequest = {
  method: string;
  path: string;
  params: URLSearchParams;
};

const stripeRequest = (
  input: string | URL | Request,
  init?: RequestInit,
): StripeRequest => ({
  method: init?.method ?? "GET",
  params: new URLSearchParams(String(init?.body ?? "")),
  path: new URL(urlFromFetchInput(input)).pathname,
});

const enabledEvents = (request: StripeRequest): string[] =>
  [...request.params.entries()]
    .filter(([key]) => key.startsWith("enabled_events["))
    .map(([, value]) => value)
    .toSorted();

const endpointResponse = (
  id: string,
  enabledEvents: readonly string[],
  secret?: string,
  url = WEBHOOK_URL,
): Response =>
  Response.json({
    enabled_events: enabledEvents,
    id,
    object: "webhook_endpoint",
    ...(secret ? { secret } : {}),
    status: "enabled",
    url,
  });

const stripeErrorResponse = (
  status: number,
  type: string,
  code?: string,
): Response =>
  Response.json(
    {
      error: {
        ...(code ? { code } : {}),
        message: "Stripe request failed",
        type,
      },
    },
    { status },
  );

const seedStoredStripe = async (): Promise<void> => {
  await settings.update.stripe.secretKey("sk_test_upgrade");
  await settings.update.stripe.webhookConfig({
    endpointId: "we_existing",
    secret: "whsec_existing",
  });
  await settings.update.paymentProvider("stripe");
  await settings.setRaw(CONFIG_KEYS.SETUP_COMPLETE, "true");
  settings.setup.clearCache();
};

const recordStripeRequests = async (
  respond: (request: StripeRequest) => Response,
  run: () => Promise<void>,
): Promise<StripeRequest[]> => {
  const requests: StripeRequest[] = [];
  await withFetchMock(async (originalFetch) => {
    installUrlHandler(originalFetch, (url, init) => {
      if (!url.includes("/v1/webhook_endpoints")) return null;
      const request = stripeRequest(url, init);
      requests.push(request);
      return Promise.resolve(respond(request));
    });
    await run();
  });
  return requests;
};

const reconcileRequests = (
  respond: (request: StripeRequest) => Response,
): Promise<StripeRequest[]> =>
  recordStripeRequests(respond, () =>
    reconcileStoredStripeWebhook(WEBHOOK_URL),
  );

const reconcileRequestsWithoutErrorLog = async (
  respond: (request: StripeRequest) => Response,
): Promise<StripeRequest[]> => {
  const errorLog = stub(console, "error");
  try {
    return await reconcileRequests(respond);
  } finally {
    errorLog.restore();
  }
};

const expectRequests = (
  requests: StripeRequest[],
  expected: Array<{ method: string; path: string }>,
): void => {
  expect(requests.map(({ method, path }) => ({ method, path }))).toEqual(
    expected,
  );
};

const expectStoredWebhook = (
  endpointId: string,
  secret: string,
  eventsVersion: string,
): void => {
  expect(settings.stripe.webhookEndpointId).toBe(endpointId);
  expect(settings.stripe.webhookSecret).toBe(secret);
  expect(settings.stripe.webhookEventsVersion).toBe(eventsVersion);
};

const withoutStoredWebhookSecret = async (
  run: () => Promise<StripeRequest[]>,
): Promise<StripeRequest[]> => {
  await seedStoredStripe();
  settings.setForTest({ stripe_webhook_secret: "" });
  try {
    return await run();
  } finally {
    settings.clearTestOverride("stripe_webhook_secret");
  }
};

const replacementResponses =
  (deletion: Response) =>
  (request: StripeRequest): Response =>
    request.method === "DELETE"
      ? deletion
      : endpointResponse(
          "we_replacement",
          REQUIRED_STRIPE_WEBHOOK_EVENTS,
          "whsec_replacement",
        );

const expectReplacement = (requests: StripeRequest[]): void => {
  expectRequests(requests, [
    { method: "DELETE", path: "/v1/webhook_endpoints/we_existing" },
    { method: "POST", path: "/v1/webhook_endpoints" },
  ]);
  expectStoredWebhook(
    "we_replacement",
    "whsec_replacement",
    STRIPE_WEBHOOK_EVENTS_VERSION,
  );
};

describeStripe("stripe webhook reconciliation", () => {
  test("does nothing when Stripe is not the payment provider", async () => {
    const requests = await reconcileRequests(() =>
      stripeErrorResponse(500, "unexpected_request"),
    );

    expectRequests(requests, []);
    expect(settings.stripe.webhookEventsVersion).toBe("");
  });

  test("does nothing when this Stripe event version is already current", async () => {
    await seedStoredStripe();
    await settings.update.stripe.webhookEventsVersion(
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );

    const requests = await reconcileRequests(() =>
      stripeErrorResponse(500, "unexpected_request"),
    );

    expectRequests(requests, []);
    expectStoredWebhook(
      "we_existing",
      "whsec_existing",
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
  });

  test("marks a Stripe install without a key as current", async () => {
    await settings.update.paymentProvider("stripe");

    const requests = await reconcileRequests(() =>
      stripeErrorResponse(500, "unexpected_request"),
    );

    expectRequests(requests, []);
    expect(settings.stripe.webhookEventsVersion).toBe(
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
  });

  test("the first request adds checkout expiry without replacing the stored signing secret", async () => {
    await seedStoredStripe();
    const requests = await recordStripeRequests(
      (request) => {
        if (request.method === "GET") {
          return endpointResponse("we_existing", [
            REQUIRED_STRIPE_WEBHOOK_EVENTS[0],
          ]);
        }
        return endpointResponse("we_existing", REQUIRED_STRIPE_WEBHOOK_EVENTS);
      },
      async () => {
        const [first, second] = await Promise.all([
          handleRequest(mockRequestWithHost("/read-only", "tickets.example")),
          handleRequest(mockRequestWithHost("/read-only", "tickets.example")),
        ]);
        const third = await handleRequest(
          mockRequestWithHost("/read-only", "tickets.example"),
        );
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(third.status).toBe(200);
      },
    );

    expectRequests(requests, [
      { method: "GET", path: "/v1/webhook_endpoints/we_existing" },
      { method: "POST", path: "/v1/webhook_endpoints/we_existing" },
    ]);
    expect(enabledEvents(requests[1]!)).toEqual(
      [...REQUIRED_STRIPE_WEBHOOK_EVENTS].toSorted(),
    );
    expectStoredWebhook(
      "we_existing",
      "whsec_existing",
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
  });

  test("replaces a missing endpoint and stores the new signing secret", async () => {
    await seedStoredStripe();
    const requests = await reconcileRequests((request) => {
      if (request.method === "GET") {
        return stripeErrorResponse(
          404,
          "invalid_request_error",
          "resource_missing",
        );
      }
      return endpointResponse(
        "we_replacement",
        REQUIRED_STRIPE_WEBHOOK_EVENTS,
        "whsec_replacement",
      );
    });

    expectRequests(requests, [
      { method: "GET", path: "/v1/webhook_endpoints/we_existing" },
      { method: "POST", path: "/v1/webhook_endpoints" },
    ]);
    expectStoredWebhook(
      "we_replacement",
      "whsec_replacement",
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
  });

  test("keeps the existing endpoint when Stripe retrieval fails transiently", async () => {
    await seedStoredStripe();
    const requests = await reconcileRequestsWithoutErrorLog(() =>
      stripeErrorResponse(500, "api_error"),
    );

    expectRequests(requests, [
      { method: "GET", path: "/v1/webhook_endpoints/we_existing" },
    ]);
    expectStoredWebhook("we_existing", "whsec_existing", "");
  });

  test("treats an all-events endpoint as current without updating it", async () => {
    await seedStoredStripe();
    const requests = await reconcileRequests(() =>
      endpointResponse("we_existing", ["*"]),
    );

    expectRequests(requests, [
      { method: "GET", path: "/v1/webhook_endpoints/we_existing" },
    ]);
    expectStoredWebhook(
      "we_existing",
      "whsec_existing",
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
  });

  test("keeps all events when correcting an endpoint URL", async () => {
    await seedStoredStripe();
    const requests = await reconcileRequests((request) =>
      request.method === "GET"
        ? endpointResponse(
            "we_existing",
            ["*"],
            undefined,
            "https://old.example/payment/webhook",
          )
        : endpointResponse("we_existing", ["*"]),
    );

    expectRequests(requests, [
      { method: "GET", path: "/v1/webhook_endpoints/we_existing" },
      { method: "POST", path: "/v1/webhook_endpoints/we_existing" },
    ]);
    expect(enabledEvents(requests[1]!)).toEqual(["*"]);
    expect(requests[1]!.params.get("url")).toBe(WEBHOOK_URL);
  });

  test("replaces an endpoint when its signing secret is missing", async () => {
    const requests = await withoutStoredWebhookSecret(() =>
      reconcileRequests(replacementResponses(Response.json({ deleted: true }))),
    );

    expectReplacement(requests);
  });

  test("replaces an endpoint when deleting its missing predecessor", async () => {
    const requests = await withoutStoredWebhookSecret(() =>
      reconcileRequests(
        replacementResponses(
          stripeErrorResponse(404, "invalid_request_error", "resource_missing"),
        ),
      ),
    );

    expectReplacement(requests);
  });

  test("keeps the stored endpoint when deleting it fails transiently", async () => {
    const requests = await withoutStoredWebhookSecret(() =>
      reconcileRequestsWithoutErrorLog(() =>
        stripeErrorResponse(500, "api_error"),
      ),
    );

    expectRequests(requests, [
      { method: "DELETE", path: "/v1/webhook_endpoints/we_existing" },
    ]);
    expectStoredWebhook("we_existing", "whsec_existing", "");
  });

  test("keeps stored verification details when replacement returns no secret", async () => {
    await seedStoredStripe();
    const requests = await reconcileRequestsWithoutErrorLog((request) =>
      request.method === "GET"
        ? stripeErrorResponse(404, "invalid_request_error", "resource_missing")
        : endpointResponse(
            "we_broken_replacement",
            REQUIRED_STRIPE_WEBHOOK_EVENTS,
          ),
    );

    expectRequests(requests, [
      { method: "GET", path: "/v1/webhook_endpoints/we_existing" },
      { method: "POST", path: "/v1/webhook_endpoints" },
    ]);
    expectStoredWebhook("we_existing", "whsec_existing", "");
  });
});
