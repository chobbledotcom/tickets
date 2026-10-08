/**
 * The in-process admin API transport for tests: it drives the real routes
 * through {@link apiRequest} with a test API key, and hands the parsed body
 * and the status back to the client, which validates the envelope.
 */

import type { AdminApiResponse } from "#shared/admin-api-client.ts";
import { apiRequest } from "./session.ts";

export const adminApiTestTransport = async (options: {
  body?: unknown;
  method: "DELETE" | "GET" | "POST" | "PUT";
  path: string;
}): Promise<AdminApiResponse> => {
  const response = await apiRequest(options.path, {
    ...(options.body === undefined
      ? {}
      : { body: options.body as Record<string, unknown> }),
    method: options.method,
  });
  const text = await response.text();
  return {
    data: JSON.parse(text) as unknown,
    status: response.status,
  };
};
