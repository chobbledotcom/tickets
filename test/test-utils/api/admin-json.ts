/** Requests to the admin JSON API with an API key, and the answers they get. */

import { assertStringIncludes } from "@std/assert";
import { handleRequest } from "#routes";
import { requireValue } from "#shared/required-value.ts";
import { assertJson } from "#test-utils/assertions.ts";
import {
  apiRequest,
  createTestEditorSession,
  createTestManagerSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";

/** A JSON request body. */
export type JsonBody = Record<string, unknown>;

/** Send `body` to an admin API path with one method. */
const sendJson =
  (method: "DELETE" | "POST" | "PUT") =>
  (path: string, body: JsonBody): Promise<Response> =>
    apiRequest(path, { body, method });

/** Send a new record to an admin API path. */
export const postJson = sendJson("POST");

/** Send changes for a record to an admin API path. */
export const putJson = sendJson("PUT");

/** Send a delete, with its confirmation, to an admin API path. */
export const deleteJson = sendJson("DELETE");

/** The record that an answer holds under `key`. */
const recordIn = (answer: Record<string, JsonBody>, key: string): JsonBody =>
  requireValue(answer[key], `The answer holds no ${key}.`);

/** Assert the status of an admin API answer, then check the record that the
 *  answer holds under `key`. Gives back that record. */
export const expectApiRecord =
  (key: string) =>
  async (
    request: Promise<Response>,
    status: number,
    check: (record: JsonBody) => void = () => {},
  ): Promise<JsonBody> =>
    recordIn(
      await assertJson<Record<string, JsonBody>>(request, status, (answer) =>
        check(recordIn(answer, key)),
      ),
      key,
    );

/** A signed-in session and the form proof that it sends. */
export type SessionProof = { cookie: string; csrfToken: string };

/** A manager's signed-in session and its form proof. */
export const managerSession = async (): Promise<SessionProof> => ({
  cookie: await createTestManagerSession(),
  csrfToken: await testCsrfToken(),
});

/** Send a request to an admin API path as a signed-in session. A body goes
 *  as JSON. */
export const requestAs = (
  session: SessionProof,
  path: string,
  { body, method }: { body?: JsonBody; method?: string } = {},
): Promise<Response> =>
  handleRequest(
    requestAsSession(path, session, {
      ...(method === undefined ? {} : { method }),
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
  );

/** Send a request to an admin API path as a manager. */
export const requestAsManager = async (
  path: string,
  init: { body?: JsonBody; method?: string } = {},
): Promise<Response> => requestAs(await managerSession(), path, init);

/** A signed-in editor's session and its form proof. */
export const editorSession = async (): Promise<SessionProof> => {
  const { cookie } = await createTestEditorSession();
  return { cookie, csrfToken: await testCsrfToken() };
};

/** Assert that the admin API refuses a request with `status`, and that its
 *  error holds `fragment`. */
export const expectApiErrorIncludes = (
  request: Promise<Response>,
  status: number,
  fragment: string,
): Promise<unknown> =>
  assertJson<{ error: string }>(request, status, (body) =>
    assertStringIncludes(body.error, fragment),
  );
