import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SETTINGS_FORMS } from "#shared/settings/forms.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("settings form routes", { db: true }, () => {
  test("every settings form posts to a route", async () => {
    for (const form of Object.values(SETTINGS_FORMS)) {
      const response = (await adminFormPost(form.action)).response;
      expect(response.status).not.toBe(404);
    }
  });
});
