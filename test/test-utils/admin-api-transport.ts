/**
 * The in-process admin API transport for tests: it drives the real routes
 * through {@link apiRequest} with a test API key, and hands the parsed body
 * and the status back to the client, which validates the envelope.
 */

import { expect } from "@std/expect";
import {
  AdminApiError,
  type AdminApiResponse,
  adminApiChildCreate,
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

/** One refused child create: the parent it names, the body, and the client's
 *  error message. */
type RefusedCreate = { body: unknown; message: string; parentId: number };

/** Assert a text child create is refused without its text and under an
 *  unknown parent, plus any `extra` refusals the resource adds. */
export const expectTextChildCreateRefusals = async <
  E extends Parameters<typeof adminApiChildCreate>[1],
>(
  entry: E,
  childKey: keyof E["children"] & string,
  parentId: number,
  extra: readonly RefusedCreate[] = [],
): Promise<void> => {
  const cases: RefusedCreate[] = [
    { body: {}, message: "text is required (status 400)", parentId },
    ...extra,
    {
      body: { text: "Nope" },
      message: `${entry.label} not found (status 404)`,
      parentId: 99999,
    },
  ];
  for (const { body, message, parentId: id } of cases) {
    await expectAdminApiError(
      adminApiChildCreate(adminApiTestTransport, entry, childKey, id, body),
      message,
    );
  }
};
