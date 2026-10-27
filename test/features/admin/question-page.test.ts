/**
 * The question entity page: the Overview tab with the edit form, answers, and
 * listings assignment, and the Actions tab with the delete.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { addAnswer, createQuestion } from "#test-utils/questions/helpers.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("the question entity page", { db: true }, () => {
  test("opens on the overview with the edit form and answers", async () => {
    const id = await createQuestion("What is your role?");
    await addAnswer(id, "One");
    await addAnswer(id, "Two");
    const html = await (await adminGet(`/admin/questions/${id}`)).text();
    assertStringIncludes(html, "What is your role?");
    assertStringIncludes(html, "One");
    assertStringIncludes(html, "Two");
  });

  test("opens the actions tab with the type-the-name delete", async () => {
    const id = await createQuestion("Delete me");
    const html = await (
      await adminGet(`/admin/questions/${id}/actions`)
    ).text();
    assertStringIncludes(html, `href="/admin/questions/${id}/delete"`);
  });

  test("answers 404 for a question that is not there", async () => {
    expect((await adminGet("/admin/questions/99999")).status).toBe(404);
  });
});
