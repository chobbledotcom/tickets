/**
 * Typed-name confirmation: the helpers that check what an operator typed, and
 * the GET/POST pair that renders a confirmation page and performs the
 * confirmed action. The integration suite drives the same machinery through
 * real routes; this mirror is what the mutation gate runs against.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ConfirmedHandlerConfig,
  createConfirmedHandlers,
  createVerifiedFormRoute,
  verifyIdentifier,
  verifyIdentifierOrJsonError,
  verifyOrRedirect,
} from "#routes/admin/confirmation.ts";
import { runWithFlashContext, setFlashContext } from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import {
  createTestManagerSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("typed-name confirmation", { db: true }, () => {
  describe("verifyIdentifier", () => {
    test("matches across case and surrounding space", () => {
      expect(verifyIdentifier("Test Listing", "test listing")).toBe(true);
      expect(verifyIdentifier("  Test  ", "test")).toBe(true);
    });

    test("rejects a different name", () => {
      expect(verifyIdentifier("Test", "Other")).toBe(false);
    });
  });

  describe("verifyOrRedirect", () => {
    test("returns null when the typed name matches", () => {
      const form = new FormParams({ confirm_identifier: "Test Listing" });

      expect(verifyOrRedirect(form, "Test Listing", "/admin/test")).toBeNull();
    });

    test("redirects with the label and no action suffix on mismatch", () => {
      const form = new FormParams({ confirm_identifier: "Wrong" });

      const result = verifyOrRedirect(form, "Test Listing", "/admin/test")!;
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toContain("/admin/test");
      expectFlash(
        result,
        "Name does not match. Please type the exact name to confirm.",
        false,
      );
    });

    test("redirects with the label and action suffix on mismatch", () => {
      const form = new FormParams({ confirm_identifier: "Wrong" });

      const result = verifyOrRedirect(
        form,
        "Test Listing",
        "/admin/test",
        "Listing name",
        "deletion",
      )!;
      expectFlash(
        result,
        "Listing name does not match. Please type the exact listing name to confirm deletion.",
        false,
      );
    });
  });

  describe("verifyIdentifierOrJsonError", () => {
    test("returns null on a match", () => {
      expect(verifyIdentifierOrJsonError("Test", "Test")).toBeNull();
    });

    test("returns the label's message on a mismatch", () => {
      const error = verifyIdentifierOrJsonError(
        "Test Listing",
        "Wrong",
        "Listing name",
      )!;
      expect(error).toBe(
        "Listing name does not match. Please provide the exact listing name in confirm_identifier.",
      );
    });

    test("treats a value that is not a string as a mismatch", () => {
      expect(verifyIdentifierOrJsonError("Test", null)).toContain(
        "does not match",
      );
    });
  });

  describe("createVerifiedFormRoute", () => {
    const buildRoute = (
      onConfirm: (args: unknown) => Promise<Response> = () =>
        Promise.resolve(new Response("done")),
    ) =>
      createVerifiedFormRoute<{ slug: string }, { slug: string }>({
        identifier: (_context, params) => `Name ${params.slug}`,
        identifierLabel: "Name",
        mismatchRedirect: (_context, params) => `/admin/away/${params.slug}`,
        onConfirm,
      });

    test("redirects when the typed name differs", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const route = buildRoute();

      const response = await route(
        mockFormRequest(
          "/admin/verified/a",
          { confirm_identifier: "Wrong", csrf_token: csrfToken },
          cookie,
        ),
        { slug: "a" },
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/admin/away/a");
      expectFlash(
        response,
        expect.stringContaining("Name does not match"),
        false,
      );
    });

    test("performs the confirmed action when the typed name matches", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const route = buildRoute();

      const response = await route(
        mockFormRequest(
          "/admin/verified/b",
          { confirm_identifier: "Name b", csrf_token: csrfToken },
          cookie,
        ),
        { slug: "b" },
      );

      expect(await response.text()).toBe("done");
    });
  });

  describe("createConfirmedHandlers", () => {
    const defaults: ConfirmedHandlerConfig<{ name: string }> = {
      identifier: (model) => Promise.resolve(model.name),
      identifierLabel: "Name",
      load: () => Promise.resolve({ name: "Alpha" }),
      onConfirm: () => Promise.resolve(),
      path: "/admin/test/:id/delete",
      render: (_model, _session, error) =>
        Promise.resolve(`page${error ? `:${error}` : ""}`),
      successMessage: "deleted",
      successRedirect: "/admin/test",
    };

    const build = (
      overrides: Partial<ConfirmedHandlerConfig<{ name: string }>> = {},
    ) =>
      createConfirmedHandlers<{ name: string }>({
        ...defaults,
        ...overrides,
      });

    test("shows the confirmation page on GET", async () => {
      const cookie = await testCookie();

      const response = await build().get(
        mockRequest("/admin/test/1/delete", { headers: { cookie } }),
        1,
      );

      expect(await response.text()).toBe("page");
    });

    test("renders a guard's error into the confirmation page", async () => {
      const cookie = await testCookie();

      const response = await build({
        guardError: () => Promise.resolve("the model is guarded"),
      }).get(mockRequest("/admin/test/1/delete", { headers: { cookie } }), 1);

      expect(await response.text()).toBe("page:the model is guarded");
    });

    test("keeps a flash error ahead of a guard's error on GET", async () => {
      const cookie = await testCookie();

      const response = await runWithFlashContext(async () => {
        setFlashContext({ error: "flash from the blocked POST" });
        return build({ guardError: () => Promise.resolve("guard") }).get(
          mockRequest("/admin/test/1/delete", { headers: { cookie } }),
          1,
        );
      });

      expect(await (await response).text()).toBe(
        "page:flash from the blocked POST",
      );
    });

    test("blocks a guarded action on POST with a redirect back", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await build({
        guardError: () => Promise.resolve("cannot delete"),
      }).post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Alpha", csrf_token: csrfToken },
          cookie,
        ),
        1,
      );

      expect(response.status).toBe(302);
      expectFlash(response, "cannot delete", false);
    });

    test("redirects back when the typed name differs", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await build().post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Wrong", csrf_token: csrfToken },
          cookie,
        ),
        1,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "/admin/test/1/delete",
      );
      expectFlash(
        response,
        "Name does not match. Please type the exact name to confirm deletion.",
        false,
      );
    });

    test("redirects with the success message after the action", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await build().post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Alpha", csrf_token: csrfToken },
          cookie,
        ),
        1,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/admin/test");
      expectFlash(response, "deleted");
    });

    test("keeps the response the action itself gave", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await build({
        onConfirm: () =>
          Promise.resolve(new Response("stayed", { status: 200 })),
      }).post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Alpha", csrf_token: csrfToken },
          cookie,
        ),
        1,
      );

      expect(await response.text()).toBe("stayed");
    });

    test("redirects to the place the success function names", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await build({
        successRedirect: (model, id) => `/admin/test/${model.name}/${id}`,
      }).post(
        mockFormRequest(
          "/admin/test/7/delete",
          { confirm_identifier: "Alpha", csrf_token: csrfToken },
          cookie,
        ),
        7,
      );

      expect(response.headers.get("location")).toContain("/admin/test/Alpha/7");
    });

    test("answers with the given not-found response", async () => {
      const cookie = await testCookie();

      const response = await build({
        load: () => Promise.resolve(null),
        onNotFound: () =>
          Promise.resolve(new Response("custom-not-found", { status: 410 })),
      }).get(
        mockRequest("/admin/test/999/delete", { headers: { cookie } }),
        999,
      );

      expect(response.status).toBe(410);
      expect(await response.text()).toBe("custom-not-found");
    });

    test("answers with the plain 404 when no custom response is given", async () => {
      const cookie = await testCookie();

      const response = await build({
        load: () => Promise.resolve(null),
      }).get(
        mockRequest("/admin/test/999/delete", { headers: { cookie } }),
        999,
      );

      expect(response.status).toBe(404);
    });

    test("answers with the pre-validation's rejection", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const rejection = new Response("blocked", {
        headers: { "x-hit": "1" },
        status: 418,
      });

      const getResponse = await build({
        preValidate: () => Promise.resolve(rejection),
      }).get(mockRequest("/admin/test/1/delete", { headers: { cookie } }), 1);
      expect(getResponse.status).toBe(418);

      const postResponse = await build({
        preValidate: () => Promise.resolve(rejection),
      }).post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Alpha", csrf_token: csrfToken },
          cookie,
        ),
        1,
      );
      expect(postResponse.status).toBe(418);
    });

    test("blocks a non-owner session unless the auth allows anyone", async () => {
      const managerCookie = await createTestManagerSession();
      const csrf = await testCsrfToken();

      const ownerResponse = await build().get(
        mockRequest("/admin/test/1/delete", {
          headers: { cookie: managerCookie },
        }),
        1,
      );
      expect(await ownerResponse.text()).not.toBe("page");

      const anyResponse = await build({ auth: "any" }).get(
        mockRequest("/admin/test/1/delete", {
          headers: { cookie: managerCookie },
        }),
        1,
      );
      expect(await anyResponse.text()).toBe("page");

      const anyPost = await build({ auth: "any" }).post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Alpha", csrf_token: csrf },
          managerCookie,
        ),
        1,
      );
      expect(anyPost.headers.get("location")).toContain("/admin/test");
    });

    test("uses the guard pair an explicit auth option names", async () => {
      const calls: string[] = [];
      const handlers = createConfirmedHandlers<
        { label: string },
        { who: string }
      >({
        auth: {
          requireSession: async (request, handler) => {
            calls.push(`session:${request.url}`);
            return handler({ who: "session" });
          },
          withForm: async (request, handler) => {
            calls.push(`form:${request.url}`);
            return handler({ who: "form" }, new FormParams({}));
          },
        },
        identifier: (model) => Promise.resolve(model.label),
        identifierLabel: "Label",
        load: () => Promise.resolve({ label: "Beta" }),
        onConfirm: () => Promise.resolve(),
        path: "/admin/pair/:id/go",
        render: () => Promise.resolve("rendered"),
        successMessage: "done",
        successRedirect: "/after",
      });

      await handlers.get(mockRequest("/admin/pair/1/go"), 1);
      await handlers.post(mockFormRequest("/admin/pair/1/go"), 1);

      expect(calls).toEqual([
        `session:${new URL("http://localhost/admin/pair/1/go")}`,
        `form:${new URL("http://localhost/admin/pair/1/go")}`,
      ]);
    });
  });
});
