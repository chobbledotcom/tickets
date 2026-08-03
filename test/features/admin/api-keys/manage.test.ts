import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getApiKeysForUser, touchApiKeyLastUsed } from "#shared/db/api-keys.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  createTestApiKeyFull,
  testCookie,
} from "#test-utils/session.ts";

describeWithEnv("API key manage page", { db: true }, () => {
  /** GET the key's manage page as the owner, assert 200, return its HTML. */
  const getManagePage = async (id: number): Promise<string> => {
    const cookie = await testCookie();
    const response = await handleRequest(
      mockRequest(`/admin/api-keys/${id}`, { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    return response.text();
  };

  describe("per-key pages", () => {
    test("GET /admin/api-keys/:id shows the summary and canonical tab links", async () => {
      const { id } = await createTestApiKeyFull("Managed Key");

      // A never-used key shows the "Never" placeholder for last used.
      const html = await getManagePage(id);
      expect(html).toContain("Managed Key");
      expect(html).toContain(`href="/admin/api-keys/${id}"`);
      expect(html).toContain(`href="/admin/api-keys/${id}/actions"`);
      expect(html).not.toContain(`/admin/api-keys/${id}/delete`);
      expect(html).toContain("Never");
      // The manage page lights up the API keys entry in the admin nav.
      expect(html).toContain('<a class="active" href="/admin/api-keys">');
    });

    test("GET /admin/api-keys/:id shows the last-used date once the key is used", async () => {
      const { id } = await createTestApiKeyFull("Managed Key");

      await touchApiKeyLastUsed(id);
      const html = await getManagePage(id);
      expect(html).not.toContain("Never");
      // The touch just happened, so the rendered date carries this year.
      expect(html).toContain(String(new Date().getFullYear()));
    });

    test("GET /admin/api-keys/:id/actions shows the delete action", async () => {
      const { id } = await createTestApiKeyFull("Managed Key");
      const cookie = await testCookie();

      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/actions`, { headers: { cookie } }),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`href="/admin/api-keys/${id}/delete"`);
      expect(html).toContain(`href="/admin/api-keys/${id}"`);
      expect(html).toContain(`href="/admin/api-keys/${id}/actions"`);
    });

    test("GET /admin/api-keys/:id rejects an unknown tab", async () => {
      const { id } = await createTestApiKeyFull("Managed Key");
      const cookie = await testCookie();

      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/unknown`, { headers: { cookie } }),
      );

      expect(response.status).toBe(404);
    });

    test("read-only mode keeps the summary but hides the actions tab", async () => {
      using _env = withEnv({
        READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      });
      const { id } = await createTestApiKeyFull("Read-only Key");
      const cookie = await testCookie();

      const summary = await handleRequest(
        mockRequest(`/admin/api-keys/${id}`, { headers: { cookie } }),
      );
      const actions = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/actions`, { headers: { cookie } }),
      );

      expect(summary.status).toBe(200);
      expect(await summary.text()).not.toContain(
        `href="/admin/api-keys/${id}/actions"`,
      );
      expect(actions.status).toBe(404);
    });

    test("GET /admin/api-keys/:id returns 404 for a nonexistent key", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys/99999", { headers: { cookie } }),
      );

      expect(response.status).toBe(404);
    });
  });

  describe("delete flow", () => {
    // Sits beside the story `@story:access.letting-another-system-in`,
    // which walks the same journey. This keeps the delete route's own line
    // covered: a Cucumber run does not feed the coverage gate.
    test("POST /admin/api-keys/:id/delete removes a key with name confirmation", async () => {
      const { id } = await createTestApiKeyFull("Doomed Key");

      const response = (
        await adminFormPost(`/admin/api-keys/${id}/delete`, {
          confirm_identifier: "Doomed Key",
        })
      ).response;

      await expectFlashRedirect(
        "/admin/api-keys",
        "API key deleted",
        true,
      )(response);
      expect(await getApiKeysForUser(1)).toEqual([]);
    });

    test("POST /admin/api-keys/:id/delete rejects wrong name", async () => {
      const { id } = await createTestApiKeyFull("My Key");

      const response = (
        await adminFormPost(`/admin/api-keys/${id}/delete`, {
          confirm_identifier: "Wrong Name",
        })
      ).response;

      // The delete-confirmation page has no error slot of its own; the Layout
      // backstop renders the mismatch error, so the operator actually sees it.
      await expectFlashRedirect(
        `/admin/api-keys/${id}/delete`,
        expect.stringContaining("API key name does not match"),
        false,
      )(response);
      expect(await getApiKeysForUser(1)).toHaveLength(1);
    });

    test("POST /admin/api-keys/:id/delete returns 404 for nonexistent key", async () => {
      const response = (
        await adminFormPost("/admin/api-keys/99999/delete", {
          confirm_identifier: "anything",
        })
      ).response;

      expect(response.status).toBe(404);
    });

    test("GET /admin/api-keys/:id/delete shows confirmation page", async () => {
      const { id } = await createTestApiKeyFull("Confirm Key");

      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest(`/admin/api-keys/${id}/delete`, {
          headers: { cookie },
        }),
      );

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Confirm Key");
      expect(html).toContain("confirm_identifier");
    });

    test("GET /admin/api-keys/:id/delete returns 404 for nonexistent key", async () => {
      const cookie = await testCookie();
      const response = await handleRequest(
        mockRequest("/admin/api-keys/99999/delete", {
          headers: { cookie },
        }),
      );

      expect(response.status).toBe(404);
    });
  });
});
