import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllUsers } from "#shared/db/users.ts";
import {
  adminFormPost,
  adminGet,
  describeWithEnv,
  expectFlashRedirect,
  expectHtmlResponse,
  TEST_ADMIN_USERNAME,
} from "#test-utils";

describeWithEnv("server (multi-user admin)", { db: true }, () => {
  describe("GET /admin/users/:id/delete", () => {
    test("shows delete confirmation page", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "todelete",
      });

      const response = await adminGet("/admin/users/2/delete");
      await expectHtmlResponse(
        response,
        200,
        "Delete User",
        "todelete",
        "confirm_identifier",
      );
    });

    test("returns 404 for nonexistent user", async () => {
      const response = await adminGet("/admin/users/999/delete");
      expect(response.status).toBe(404);
    });

    test("rejects deleting self", async () => {
      const response = await adminGet("/admin/users/1/delete");
      await expectHtmlResponse(response, 400, "Cannot delete your own account");
    });
  });

  describe("POST /admin/users/:id/delete", () => {
    test("deletes a user with correct confirmation", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "deleteme",
      });

      const usersBefore = await getAllUsers();
      expect(usersBefore.length).toBe(2);

      const { response } = await adminFormPost("/admin/users/2/delete", {
        confirm_identifier: "deleteme",
      });
      await expectFlashRedirect(
        "/admin/users",
        expect.stringContaining("deleted"),
      )(response);

      const usersAfter = await getAllUsers();
      expect(usersAfter.length).toBe(1);
    });

    test("rejects deletion with wrong confirmation", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "keepme",
      });

      const { response } = await adminFormPost("/admin/users/2/delete", {
        confirm_identifier: "wrongname",
      });
      await expectFlashRedirect(
        "/admin/users/2/delete",
        expect.stringContaining("Username does not match"),
        false,
      )(response);

      const usersAfter = await getAllUsers();
      expect(usersAfter.length).toBe(2);
    });

    test("rejects deletion without confirmation", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "manager",
        username: "keepme2",
      });

      const { response } = await adminFormPost("/admin/users/2/delete");
      await expectFlashRedirect(
        "/admin/users/2/delete",
        expect.stringContaining("Username does not match"),
        false,
      )(response);
    });

    test("prevents deleting self", async () => {
      const { response } = await adminFormPost("/admin/users/1/delete", {
        confirm_identifier: TEST_ADMIN_USERNAME,
      });
      await expectHtmlResponse(response, 400, "Cannot delete your own account");
    });

    test("deletes another owner with correct confirmation", async () => {
      await adminFormPost("/admin/users", {
        admin_level: "owner",
        username: "otheradmin",
      });

      const usersBefore = await getAllUsers();
      expect(usersBefore.length).toBe(2);

      const { response } = await adminFormPost("/admin/users/2/delete", {
        confirm_identifier: "otheradmin",
      });
      await expectFlashRedirect(
        "/admin/users",
        expect.stringContaining("deleted"),
      )(response);

      const usersAfter = await getAllUsers();
      expect(usersAfter.length).toBe(1);
    });
  });

  describe("POST /admin/users/:id/delete (not found)", () => {
    test("returns 404 for nonexistent user", async () => {
      const { response } = await adminFormPost("/admin/users/999/delete");
      await expectHtmlResponse(response, 404, "User not found");
    });
  });
});
