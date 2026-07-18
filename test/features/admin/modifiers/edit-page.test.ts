import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";
import { createData, lastModifier } from "./helpers.ts";

describeWithEnv("server (admin modifiers)", { db: true }, () => {
  describe("GET /admin/modifiers/:id/edit", () => {
    testRequiresAuth("/admin/modifiers/1/edit", {
      setup: async () => {
        await adminFormPost("/admin/modifiers", createData());
      },
    });

    test("shows the edit form with current values", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Editable" }));
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(response, 200, "Editable", "Edit");
    });

    test("uses canonical entity tab links", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Tabbed" }));
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}`);
      const html = await expectHtmlResponse(
        response,
        200,
        "Tabbed",
        "Edit",
        "Actions",
        "/admin/guide#modifiers",
      );
      expect(html).toContain(
        `aria-current="page" class="active" href="/admin/modifiers/${id}/edit"`,
      );
      expect(html).toContain('<a class="active" href="/admin/modifiers">');
      expect(html).toContain(`href="/admin/modifiers/${id}/actions"`);
    });

    test("returns 404 for an unknown tab", async () => {
      await adminFormPost("/admin/modifiers", createData());
      const { id } = await lastModifier();
      expectStatus(404)(await adminGet(`/admin/modifiers/${id}/unknown`));
    });

    test("shows the minimum order in major units on the edit form", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ min_subtotal: "50" }),
      );
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(response, 200, 'value="50"');
    });

    test("shows the stock limit on the edit form", async () => {
      await adminFormPost("/admin/modifiers", createData({ stock: "7" }));
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      await expectHtmlResponse(response, 200, 'value="7"');
    });

    test("returns 404 for a missing modifier", async () => {
      const response = await adminGet("/admin/modifiers/999/edit");
      expectStatus(404)(response);
    });

    test("shows the income-correction form with its Money warning", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Surcharge" }),
      );
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      const html = await response.text();
      expect(html).toContain("Adjust revenue");
      expect(html).toContain(`action="/admin/modifiers/${id}/revenue"`);
      expect(html).toContain('name="total_revenue"');
      expect(html).toContain("This adds a correction to Money.");
    });

    test("shows the owner-only modifier ledger section", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Helmet hire" }),
      );
      const { id } = await lastModifier();
      const response = await adminGet(`/admin/modifiers/${id}/edit`);
      const html = await response.text();
      expect(html).toContain("Money");
      expect(html).not.toContain("Money history");
      expect(html).toContain("Add money change");
      expect(html).toContain(
        `/admin/ledger/modifier/${id}/add?return_url=%2Fadmin%2Fmodifiers%2F${id}%2Fedit`,
      );
    });

    test("omits the ledger section for managers", async () => {
      await adminFormPost(
        "/admin/modifiers",
        createData({ name: "Manager visible" }),
      );
      const { id } = await lastModifier();
      const response = await awaitTestRequest(`/admin/modifiers/${id}/edit`, {
        cookie: await createTestManagerSession("mgr-modifier-edit"),
      });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Manager visible");
      expect(html).not.toContain("<h2>Money</h2>");
      expect(html).not.toContain(`/admin/ledger/modifier/${id}/add`);
    });

    test("shows delete only on the Actions tab", async () => {
      await adminFormPost("/admin/modifiers", createData({ name: "Actions" }));
      const { id } = await lastModifier();
      const editHtml = await (
        await adminGet(`/admin/modifiers/${id}/edit`)
      ).text();
      const actions = await adminGet(`/admin/modifiers/${id}/actions`);
      expect(editHtml).not.toContain(`/admin/modifiers/${id}/delete`);
      await expectHtmlResponse(
        actions,
        200,
        "Actions",
        `/admin/modifiers/${id}/delete`,
      );
    });
  });
});
