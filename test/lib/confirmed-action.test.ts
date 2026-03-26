/**
 * Tests for createConfirmedAction generic factory
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

import { createConfirmedAction } from "#routes/admin/utils.ts";
import {
  describeWithEnv,
  expectRedirectWithFlash,
  mockFormRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Simple resource type for tests */
type TestResource = { id: number; name: string };

/** Create a confirmed action with test defaults */
const createTestAction = (
  loadResource: (
    session: unknown,
    params: { id: number },
  ) => Promise<TestResource | null>,
) =>
  createConfirmedAction<TestResource, { id: number }>({
    loadResource,
    getIdentifier: (r) => r.name,
    redirectPath: ({ id }, action) => `/test/${id}/${action}`,
    label: "Resource name",
  });

describeWithEnv("createConfirmedAction", { db: true }, () => {
  const resource: TestResource = { id: 1, name: "Test Item" };

  describe("resource loading", () => {
    test("returns 404 when resource is not found", async () => {
      let handlerCalled = false;
      const action = createTestAction(() => Promise.resolve(null));
      const route = action("delete", "deletion", () => {
        handlerCalled = true;
        return new Response();
      });

      const response = await route(
        mockFormRequest(
          "/test/1/delete",
          {
            confirm_identifier: "Test Item",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expect(response.status).toBe(404);
      expect(handlerCalled).toBe(false);
    });
  });

  describe("identifier verification", () => {
    test("returns error redirect when identifier does not match", async () => {
      let handlerCalled = false;
      const action = createTestAction(() => Promise.resolve(resource));
      const route = action("delete", "deletion", () => {
        handlerCalled = true;
        return new Response();
      });

      const response = await route(
        mockFormRequest(
          "/test/1/delete",
          {
            confirm_identifier: "Wrong Name",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expectRedirectWithFlash(
        "/test/1/delete",
        "Resource name does not match. Please type the exact resource name to confirm deletion.",
        false,
      )(response);
      expect(handlerCalled).toBe(false);
    });

    test("matches identifier case-insensitively", async () => {
      const action = createTestAction(() => Promise.resolve(resource));
      const route = action(
        "delete",
        "deletion",
        (_r, _f, _p) => new Response(null, { status: 200 }),
      );

      const response = await route(
        mockFormRequest(
          "/test/1/delete",
          {
            confirm_identifier: "test item",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expect(response.status).toBe(200);
    });
  });

  describe("handler invocation", () => {
    test("calls handler with resource, form, and params when identifier matches", async () => {
      const action = createTestAction(() => Promise.resolve(resource));
      const route = action("delete", "deletion", (r, form, params) => {
        expect(r).toEqual(resource);
        expect(form.getString("confirm_identifier")).toBe("Test Item");
        expect(params).toEqual({ id: 1 });
        return new Response("ok", { status: 200 });
      });

      const response = await route(
        mockFormRequest(
          "/test/1/delete",
          {
            confirm_identifier: "Test Item",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expect(response.status).toBe(200);
    });

    test("passes session to loadResource", async () => {
      let receivedSession: unknown;
      let receivedParams: unknown;
      const action = createTestAction((session, params) => {
        receivedSession = session;
        receivedParams = params;
        return Promise.resolve(resource);
      });
      const route = action(
        "archive",
        undefined,
        () => new Response(null, { status: 200 }),
      );

      await route(
        mockFormRequest(
          "/test/1/archive",
          {
            confirm_identifier: "Test Item",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expect(receivedSession).toBeDefined();
      expect(receivedParams).toEqual({ id: 1 });
    });
  });

  describe("action label in error message", () => {
    test("includes action label in error message when provided", async () => {
      const action = createTestAction(() => Promise.resolve(resource));
      const route = action("delete", "deletion", () => new Response());

      const response = await route(
        mockFormRequest(
          "/test/1/delete",
          {
            confirm_identifier: "wrong",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expectRedirectWithFlash(
        "/test/1/delete",
        "Resource name does not match. Please type the exact resource name to confirm deletion.",
        false,
      )(response);
    });

    test("omits action suffix when actionLabel is undefined", async () => {
      const action = createTestAction(() => Promise.resolve(resource));
      const route = action("resend", undefined, () => new Response());

      const response = await route(
        mockFormRequest(
          "/test/1/resend",
          {
            confirm_identifier: "wrong",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
        { id: 1 },
      );

      expectRedirectWithFlash(
        "/test/1/resend",
        "Resource name does not match. Please type the exact resource name to confirm.",
        false,
      )(response);
    });
  });

  describe("authentication", () => {
    test("redirects to login when not authenticated", async () => {
      let handlerCalled = false;
      const action = createTestAction(() => Promise.resolve(resource));
      const route = action("delete", "deletion", () => {
        handlerCalled = true;
        return new Response();
      });

      const response = await route(
        mockFormRequest("/test/1/delete", { confirm_identifier: "Test Item" }),
        { id: 1 },
      );

      expect(response.status).toBe(302);
      expect(handlerCalled).toBe(false);
    });
  });
});
