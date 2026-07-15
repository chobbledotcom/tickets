import {
  cleanupOldWebhookEndpoints,
  setupWebhookEndpoint,
} from "#shared/stripe.ts";
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
  createThrowsNonError?: boolean;
  createThrowsWebhookOnly?: boolean;
  deleteFails?: boolean;
  listFails?: boolean;
  recordedInListing?: boolean;
  sameUrlStray?: boolean;
};

export const webhookEndpointsApi = (
  webhookUrl: string,
  calls: WebhookApiCalls,
  options: WebhookApiOptions = {},
): ((url: string, init?: RequestInit) => Promise<Response> | null) => {
  const {
    createFails = false,
    createLimitError = false,
    createThrowsMaximum = false,
    createThrowsNonError = false,
    createThrowsWebhookOnly = false,
    deleteFails = false,
    listFails = false,
    recordedInListing = false,
    sameUrlStray = true,
  } = options;
  const listed = {
    data: [
      ...(sameUrlStray
        ? [{ id: "we_stray", object: "webhook_endpoint", url: webhookUrl }]
        : []),
      {
        id: "we_other",
        object: "webhook_endpoint",
        url: "https://other.example/webhook",
      },
      ...(recordedInListing
        ? [{ id: "we_recorded", object: "webhook_endpoint", url: webhookUrl }]
        : []),
    ],
    has_more: false,
    object: "list",
  };
  const created = {
    id: "we_new",
    object: "webhook_endpoint",
    secret: "whsec_new",
    status: "enabled",
    url: webhookUrl,
  };

  const limitErrorResponse = Response.json(
    {
      error: {
        message: "You have reached the webhook endpoint limit",
        type: "invalid_request_error",
      },
    },
    { status: 400 },
  );
  const createErrorResponse = Response.json(
    { error: { message: "Create failed", type: "api_error" } },
    { status: 500 },
  );
  const webhookOnlyErrorResponse = Response.json(
    {
      error: {
        message: "Invalid webhook URL format",
        type: "invalid_request_error",
      },
    },
    { status: 400 },
  );

  const handleCreatePost = (init?: RequestInit): Promise<Response> => {
    calls.createAttempts++;
    if (createThrowsNonError && calls.createAttempts === 1) {
      throw "not an error";
    }
    if (createThrowsMaximum && calls.createAttempts === 1) {
      return Promise.resolve(
        Response.json(
          {
            error: {
              message: "Maximum number of webhook endpoints reached",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        ),
      );
    }
    if (createLimitError && calls.createAttempts === 1) {
      return Promise.resolve(limitErrorResponse);
    }
    if (createThrowsWebhookOnly && calls.createAttempts === 1) {
      return Promise.resolve(webhookOnlyErrorResponse);
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
      return Promise.resolve(Response.json({ deleted: true }));
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
    return await setupWebhookEndpoint(
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
    return await cleanupOldWebhookEndpoints(
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
