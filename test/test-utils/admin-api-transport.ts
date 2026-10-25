/**
 * The in-process admin API transport for tests: it drives the real routes
 * through {@link apiRequest} with a test API key, and hands the parsed body
 * and the status back to the client, which validates the envelope.
 */

import { expect } from "@std/expect";
import {
  AdminApiError,
  type AdminApiResponse,
} from "#shared/admin-api-client.ts";
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

/** Run one admin API call, and assert it fails with the AdminApiError whose
 *  message the caller names — the client's "<server message> (status <n>)"
 *  shape. */
export const expectAdminApiError = async (
  call: Promise<unknown>,
  message: string,
): Promise<void> => {
  const failure = await call.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AdminApiError);
  expect((failure as Error).message).toBe(message);
};
