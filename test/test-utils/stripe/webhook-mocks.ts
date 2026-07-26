import { stripeApi } from "#shared/stripe.ts";
import { installUrlHandler, withFetchMock } from "#test-utils/mocks.ts";

export type WebhookApiCalls = {
  createAttempts: number;
  createdBody: URLSearchParams | null;
  deleted: string[];
  liveEndpointIds: Set<string>;
};

export type WebhookApiOptions = {
  createFails?: boolean;
  createLimitError?: boolean;
  createThrowsMaximum?: boolean;
  createThrowsMaximumWithoutWebhook?: boolean;
  createThrowsNonError?: boolean;
  createThrowsWebhookOnly?: boolean;
  deleteFails?: boolean;
  listFails?: boolean;
  omitSecret?: boolean;
  recordedInListing?: boolean;
  sameUrlStray?: boolean;
};

const stripeErrorResponse = (message: string, status = 400): Response =>
  Response.json(
    { error: { message, type: "invalid_request_error" } },
    { status },
  );

const firstCreateError = (options: WebhookApiOptions): Response | null => {
  if (options.createThrowsMaximum) {
    return stripeErrorResponse("Maximum number of webhook endpoints reached");
  }
  if (options.createThrowsMaximumWithoutWebhook) {
    return stripeErrorResponse("Maximum number of resources reached");
  }
  if (options.createLimitError) {
    return stripeErrorResponse("You have reached the webhook endpoint limit");
  }
  if (options.createThrowsWebhookOnly) {
    return stripeErrorResponse("Invalid webhook URL format");
  }
  return null;
};

export const webhookEndpointsApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  options: WebhookApiOptions = {},
): ((url: string, init?: RequestInit) => Promise<Response> | null) => {
  const {
    createFails = false,
    createThrowsNonError = false,
    deleteFails = false,
    listFails = false,
    omitSecret = false,
    recordedInListing = false,
    sameUrlStray = true,
  } = options;
  const listed = {
    data: [
      ...(sameUrlStray
        ? [
            {
              enabled_events: ["checkout.session.completed"],
              id: "we_stray",
              object: "webhook_endpoint",
              status: "enabled",
              url: webhookUrl,
            },
          ]
        : []),
      {
        enabled_events: ["checkout.session.completed"],
        id: "we_other",
        object: "webhook_endpoint",
        status: "enabled",
        url: "https://other.example/webhook",
      },
      ...(recordedInListing
        ? [
            {
              enabled_events: ["checkout.session.completed"],
              id: "we_recorded",
              object: "webhook_endpoint",
              status: "enabled",
              url: webhookUrl,
            },
          ]
        : []),
    ],
    has_more: false,
    object: "list",
  };
  const created = {
    id: "we_new",
    object: "webhook_endpoint",
    ...(omitSecret ? {} : { secret: "whsec_new" }),
    status: "enabled",
    url: webhookUrl,
  };

  const createErrorResponse = Response.json(
    { error: { message: "Create failed", type: "api_error" } },
    { status: 500 },
  );
  const handleCreatePost = (init?: RequestInit): Promise<Response> => {
    calls.createAttempts++;
    if (createThrowsNonError && calls.createAttempts === 1) {
      throw "not an error";
    }
    const firstError = firstCreateError(options);
    if (calls.createAttempts === 1 && firstError) {
      return Promise.resolve(firstError);
    }
    if (createFails) return Promise.resolve(createErrorResponse);
    calls.createdBody = new URLSearchParams(String(init?.body ?? ""));
    calls.liveEndpointIds.add(created.id);
    return Promise.resolve(Response.json(created));
  };

  return (url, init) => {
    if (!url.includes("/v1/webhook_endpoints")) return null;
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return listFails
        ? Promise.resolve(
            Response.json(
              { error: { message: "List failed", type: "api_error" } },
              { status: 500 },
            ),
          )
        : Promise.resolve(Response.json(listed));
    }
    if (method === "DELETE") {
      if (deleteFails) throw new Error("Delete failed");
      const id = new URL(url).pathname.split("/").pop()!;
      calls.deleted.push(id);
      calls.liveEndpointIds.delete(id);
      return Promise.resolve(Response.json({ deleted: true, id }));
    }
    return handleCreatePost(init);
  };
};

export const setupWithWebhookApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  existingEndpointId?: string,
  options: WebhookApiOptions = {},
) =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(
      originalFetch,
      webhookEndpointsApi(webhookUrl, calls, options),
    );
    return await stripeApi.setupWebhookEndpoint(
      "sk_test_mock",
      webhookUrl,
      existingEndpointId,
    );
  });

export const cleanupWithWebhookApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  keepEndpointId: string,
  options: WebhookApiOptions = {},
) =>
  withFetchMock(async (originalFetch) => {
    installUrlHandler(
      originalFetch,
      webhookEndpointsApi(webhookUrl, calls, options),
    );
    return await stripeApi.cleanupOldWebhookEndpoints(
      "sk_test_mock",
      webhookUrl,
      keepEndpointId,
    );
  });

export const newWebhookApiCalls = (): WebhookApiCalls => ({
  createAttempts: 0,
  createdBody: null,
  deleted: [],
  liveEndpointIds: new Set(["we_other", "we_recorded", "we_stray"]),
});
