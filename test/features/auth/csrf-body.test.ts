/**
 * The CSRF check and the body it reads, per body mode.
 *
 * A JSON call carries its token in the `x-csrf-token` header; a form carries
 * it in a `csrf_token` field. A read-only JSON call needs no token at all,
 * because it cannot change anything, and an API key needs none either — the
 * key is the secret.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  ADMIN_API,
  AUTH_FORM,
  AUTH_MULTIPART,
  SCANNER_JSON,
  withAuth,
} from "#routes/auth.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  createTestApiKeyToken,
  getTestSession,
  requestAsApiKey,
} from "#test-utils/session.ts";

const FORBIDDEN = 403;
const OK = 200;

/** Run a policy and answer with what the body parsed to, so a refusal and an
 * admission can never read the same. */
const run = async (
  policy: Parameters<typeof withAuth>[1],
  request: Request,
): Promise<Response> =>
  await withAuth(request, policy, (_session, body) =>
    Promise.resolve(Response.json({ body: JSON.parse(JSON.stringify(body)) })),
  );

const jsonRequest = async (
  method: string,
  opts: { token?: string; contentType?: string; body?: string } = {},
): Promise<Request> => {
  const { cookie } = await getTestSession();
  const headers = new Headers({ cookie, host: "localhost" });
  if (opts.token !== undefined) headers.set("x-csrf-token", opts.token);
  if (opts.contentType !== undefined) {
    headers.set("content-type", opts.contentType);
  }
  return new Request("http://localhost/api/admin/x", {
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: opts.body ?? "{}" }),
    headers,
    method,
  });
};

describeWithEnv("a JSON call that changes something", { db: true }, () => {
  const errors = setupErrorSpy();

  test("is admitted with the token in the x-csrf-token header", async () => {
    const request = await jsonRequest("POST", {
      contentType: "application/json",
      token: await signCsrfToken(),
    });

    expect((await run(ADMIN_API, request)).status).toBe(OK);
  });

  test("is refused without a token, and the refusal is logged", async () => {
    const request = await jsonRequest("POST", {
      contentType: "application/json",
    });

    expect((await run(ADMIN_API, request)).status).toBe(FORBIDDEN);
    expect(errors.contains("JSON API")).toBe(true);
  });

  test("is refused with a token that is not ours", async () => {
    const request = await jsonRequest("POST", {
      contentType: "application/json",
      token: "not-a-real-token",
    });

    expect((await run(ADMIN_API, request)).status).toBe(FORBIDDEN);
  });

  test("is admitted on an API key with no token at all", async () => {
    // The key is the secret, so there is nothing for a CSRF token to add.
    const apiKey = await createTestApiKeyToken();
    const request = requestAsApiKey("/api/admin/x", apiKey, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect((await run(ADMIN_API, request)).status).toBe(OK);
  });
});

describeWithEnv("a JSON call that only reads", { db: true }, () => {
  test("needs no token, because it cannot change anything", async () => {
    // A calendar client fetching an .ics feed cannot attach a header.
    expect((await run(ADMIN_API, await jsonRequest("GET"))).status).toBe(OK);
  });

  test("needs none for a HEAD either", async () => {
    expect((await run(ADMIN_API, await jsonRequest("HEAD"))).status).toBe(OK);
  });

  test("is still refused a token-less write", async () => {
    const request = await jsonRequest("PUT", {
      contentType: "application/json",
    });

    expect((await run(SCANNER_JSON, request)).status).toBe(FORBIDDEN);
  });
});

describeWithEnv("what a JSON body must look like", { db: true }, () => {
  const errors = setupErrorSpy();

  const post = async (
    opts: { contentType?: string; body?: string } = {},
  ): Promise<Response> =>
    await run(
      ADMIN_API,
      await jsonRequest("POST", { ...opts, token: await signCsrfToken() }),
    );

  test("refuses a write that is not sent as JSON", async () => {
    const response = await post({ body: "hello", contentType: "text/plain" });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid request body");
  });

  test("refuses JSON that does not parse", async () => {
    const response = await post({
      body: "{ not json",
      contentType: "application/json",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid request body");
    expect(errors.contains("Malformed JSON body")).toBe(true);
  });

  test("refuses JSON that parses to something other than an object", async () => {
    const response = await post({
      body: "[1,2]",
      contentType: "application/json",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid request body");
  });

  test("hands the parsed object to the handler", async () => {
    const response = await post({
      body: JSON.stringify({ hello: "there" }),
      contentType: "application/json",
    });

    expect(await response.json()).toEqual({ body: { hello: "there" } });
  });

  test("lets a read with no JSON body through as an empty object", async () => {
    const { cookie } = await getTestSession();
    const response = await run(
      ADMIN_API,
      new Request("http://localhost/api/admin/x", {
        headers: { cookie, host: "localhost" },
      }),
    );

    expect(await response.json()).toEqual({ body: {} });
  });
});

/** A body mode that always carries its token in a `csrf_token` field, whatever
 * the method. Both such modes answer the same three questions, so they are
 * asked once: `run` authenticates the request and answers with the `hello`
 * field, so an admission and a refusal can never read the same. */
const carriesItsTokenInAField = (
  what: string,
  build: (fields: Record<string, string>) => Promise<Request>,
  run: (request: Request) => Promise<Response>,
): void =>
  describeWithEnv(what, { db: true }, () => {
    test("is admitted with the token in its csrf_token field", async () => {
      const response = await run(
        await build({ csrf_token: await signCsrfToken(), hello: "there" }),
      );

      expect(response.status).toBe(OK);
      expect(await response.text()).toBe("there");
    });

    test("is refused when the field is missing", async () => {
      const response = await run(await build({ hello: "there" }));

      expect(response.status).toBe(FORBIDDEN);
      expect(await response.text()).toBe("Invalid CSRF token");
    });

    test("is refused when the field holds padding rather than a token", async () => {
      const response = await run(
        await build({ csrf_token: "   ", hello: "there" }),
      );

      expect(response.status).toBe(FORBIDDEN);
    });
  });

const formBody = async (fields: Record<string, string>): Promise<Request> => {
  const { cookie } = await getTestSession();
  return new Request("http://localhost/admin/x", {
    body: new URLSearchParams(fields).toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      host: "localhost",
    },
    method: "POST",
  });
};

const multipartBody = async (
  fields: Record<string, string>,
): Promise<Request> => {
  const { cookie } = await getTestSession();
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("http://localhost/admin/x", {
    body: form,
    headers: { cookie, host: "localhost" },
    method: "POST",
  });
};

carriesItsTokenInAField("a form submission", formBody, (request) =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    Promise.resolve(new Response(form.getString("hello"))),
  ),
);

carriesItsTokenInAField("a multipart submission", multipartBody, (request) =>
  withAuth(request, AUTH_MULTIPART, (_session, formData) =>
    Promise.resolve(new Response(String(formData.get("hello")))),
  ),
);

describeWithEnv("a form sent as a read", { db: true }, () => {
  test("is still refused without a token, because a form always writes", async () => {
    const { cookie } = await getTestSession();
    const request = new Request("http://localhost/admin/x", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: "localhost",
      },
    });

    const response = await withAuth(request, AUTH_FORM, () =>
      Promise.resolve(new Response("in")),
    );

    expect(response.status).toBe(FORBIDDEN);
  });
});
