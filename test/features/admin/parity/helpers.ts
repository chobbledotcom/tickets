// Shared request builders for the parity pin suites. Every pin drives the real
// routes: the page surface with the owner's cookie and CSRF token, the JSON
// surface with the same session. A pin never builds a request by hand, so the
// request shape stays out of the comparisons.

import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

/** POST the page form route with the owner's session. */
export const ownerPagePost = async (
  path: string,
  data: Record<string, string>,
): Promise<Response> => pagePostAs(path, data, await testCookie());

/** POST the page form route with an explicit session cookie. */
export const pagePostAs = async (
  path: string,
  data: Record<string, string>,
  cookie: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      path,
      { ...data, csrf_token: await testCsrfToken() },
      cookie,
    ),
  );

const apiRequestAs = async (
  path: string,
  method: string,
  body: Record<string, unknown> | undefined,
  cookie: string,
): Promise<Response> =>
  handleRequest(
    requestAsSession(
      path,
      {
        cookie,
        csrfToken: await testCsrfToken(),
      },
      // A bodyless read carries no content type: the API treats a JSON
      // content type on a safe method as a body it must parse.
      body === undefined
        ? { method }
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method,
          },
    ),
  );

const ownerApiRequest = async (
  path: string,
  method: string,
  body: Record<string, unknown> | undefined,
): Promise<Response> => apiRequestAs(path, method, body, await testCookie());

/** POST the JSON route with the owner's session. */
export const ownerApiPost = (
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => ownerApiRequest(path, "POST", body);

/** GET the JSON route with the owner's session. */
export const ownerApiGet = (path: string): Promise<Response> =>
  ownerApiRequest(path, "GET", undefined);

/** PUT the JSON route with the owner's session. */
export const ownerApiPut = (
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => ownerApiRequest(path, "PUT", body);

/** DELETE the JSON route with the owner's session. */
export const ownerApiDelete = (
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => ownerApiRequest(path, "DELETE", body);

/** POST the JSON route with an explicit session cookie (a role below the
 *  owner). */
export const apiPostAs = (
  path: string,
  body: Record<string, unknown>,
  cookie: string,
): Promise<Response> => apiRequestAs(path, "POST", body, cookie);

/** Pins that an API update refuses a non-string name with the field
 *  message. Creates the entity through the same API first, so the pin
 *  reads one resource shape per call. */
export const expectNonStringNameRefused = async (
  resource: string,
  key: string,
  createBody: Record<string, unknown>,
): Promise<void> => {
  const created = await assertJson<Record<string, { id: number }>>(
    ownerApiPost(`/api/admin/${resource}`, createBody),
    201,
  );
  const entity = created[key]!;
  await assertJson(
    ownerApiPut(`/api/admin/${resource}/${entity.id}`, { name: 123 }),
    400,
    (body) => {
      expect(body.error).toBe("name must be a string");
    },
  );
};
