/** How often a question asks. The add form sets it when the owner creates the
 * question, and nothing can change it afterwards. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { openDiscos, withPupilName } from "#test/blackbox/discos.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const ASKS_EACH_LISTING = "This question asks: One per listing.";

describeWithEnv("the answer level of a question", { db: true }, () => {
  test("the add form creates a question that asks once for each listing", async () => {
    const { owner, question } = await withPupilName(await openDiscos());

    const page = await owner.get(`/admin/questions/${question}`);

    expect(page.html).toContain(ASKS_EACH_LISTING);
  });

  test("the edit form refuses a changed level, and a plain save keeps the stored one", async () => {
    const { owner, question } = await withPupilName(await openDiscos());
    const path = `/admin/questions/${question}`;
    const edit = `${path}/edit`;

    const refused = await owner.submit(path, { answerLevel: "booking" }, edit);
    const saved = await owner.submit(path, {}, edit);

    expect(refused.status).toBe(400);
    expect(refused.html).toContain(t("questions.answer_level.locked"));
    expect(saved.status).toBe(302);
    expect((await owner.get(path)).html).toContain(ASKS_EACH_LISTING);
  });
});
