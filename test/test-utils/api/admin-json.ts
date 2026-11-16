/** Requests to the admin JSON API with an API key, and the answers they get. */

import { assertJson } from "#test-utils/assertions.ts";
import { apiRequest } from "#test-utils/session.ts";

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
const recordIn = (answer: Record<string, JsonBody>, key: string): JsonBody => {
  const record = answer[key];
  if (record === undefined) throw new Error(`The answer holds no ${key}.`);
  return record;
};

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
