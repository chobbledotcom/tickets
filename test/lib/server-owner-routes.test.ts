import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  createTestManagerSession,
  describeWithEnv,
  mockFormRequest,
  mockRequest,
} from "#test-utils";

describeWithEnv("server (owner-only route authorization)", { db: true }, () => {
  const ownerOnlyGetRoutes = [
    "/admin/settings",
    "/admin/settings-advanced",
    "/admin/users",
    "/admin/api-keys",
    "/admin/backup",
    "/admin/debug",
    "/admin/update",
    "/admin/questions",
    "/admin/sessions",
  ];

  const ownerOnlyPostRoutes: Array<{
    body: Record<string, string>;
    path: string;
  }> = [
    { body: { csrf_token: "mgr-csrf" }, path: "/admin/settings" },
    {
      body: { csrf_token: "mgr-csrf", name: "Test Key" },
      path: "/admin/api-keys",
    },
    { body: { csrf_token: "mgr-csrf" }, path: "/admin/backup/create" },
    { body: { csrf_token: "mgr-csrf" }, path: "/admin/update/check" },
    { body: { csrf_token: "mgr-csrf" }, path: "/admin/sessions" },
  ];

  describe("GET routes reject manager with 403", () => {
    for (const path of ownerOnlyGetRoutes) {
      test(`${path} returns 403 for manager`, async () => {
        const managerCookie = await createTestManagerSession();
        const response = await handleRequest(
          mockRequest(path, { headers: { cookie: managerCookie } }),
        );
        expect(response.status).toBe(403);
      });
    }
  });

  describe("POST routes reject manager with 403", () => {
    for (const { body, path } of ownerOnlyPostRoutes) {
      test(`POST ${path} returns 403 for manager`, async () => {
        const managerCookie = await createTestManagerSession();
        const response = await handleRequest(
          mockFormRequest(path, body, managerCookie),
        );
        expect(response.status).toBe(403);
      });
    }
  });
});
