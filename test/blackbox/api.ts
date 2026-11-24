/**
 * The admin JSON API as another system sees it: an API key, JSON in, JSON out.
 *
 * A black-box test seeds state through this client, so it never writes to the
 * database. Get a key with `openApi` in `seed.ts`.
 */

import type { Target } from "#test/blackbox/driver.ts";

/** What the API answered: the status, and the JSON body (null when empty). */
export interface Answer {
  body: unknown;
  status: number;
}

export interface Api {
  delete(path: string, body?: unknown): Promise<Answer>;
  get(path: string): Promise<Answer>;
  post(path: string, body: unknown): Promise<Answer>;
  put(path: string, body: unknown): Promise<Answer>;
  /** The status of one request, whatever the body. A path that no route
   * serves answers with a page, not JSON. */
  statusOf(method: string, path: string, body?: unknown): Promise<number>;
}

/** The body of a response as JSON. The API always answers with JSON, so text
 * that does not parse is a failure that names what came back. */
const readBody = (path: string, text: string): unknown => {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The API answered ${path} with text that is not JSON: ${text}`,
    );
  }
};

/** Send one request with the key, and give back the response. */
const exchange = (
  target: Target,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> => {
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    host: "localhost",
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return target(
    new Request(`http://localhost${path}`, {
      body: body === undefined ? null : JSON.stringify(body),
      headers,
      method,
    }),
  );
};

/** Send one request with the key, and read the answer. */
const send = async (
  target: Target,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> => {
  const response = await exchange(target, key, method, path, body);
  return {
    body: readBody(path, await response.text()),
    status: response.status,
  };
};

/** A client that sends `key` with every request. */
export const createApi = (target: Target, key: string): Api => ({
  delete: (path, body) => send(target, key, "DELETE", path, body),
  get: (path) => send(target, key, "GET", path),
  post: (path, body) => send(target, key, "POST", path, body),
  put: (path, body) => send(target, key, "PUT", path, body),
  statusOf: async (method, path, body) =>
    (await exchange(target, key, method, path, body)).status,
});
