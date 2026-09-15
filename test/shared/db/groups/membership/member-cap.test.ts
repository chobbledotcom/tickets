/** The submitted member-cap fence that lives in membership.ts
 *  (submittedMembersCapErrorTx): every submitted member is judged against
 *  its cap, one member exactly as much as several. The group-write driver
 *  around it is fenced in `package-writes/package-cap.test.ts`. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { arrangeGroupWrite } from "./package-writes/arrange.ts";

describeWithEnv("db > groups > submitted member caps", { db: true }, () => {
  test("a lone submitted member is judged against its cap", async () => {
    const { run } = await arrangeGroupWrite("Solo Seat", 2, 1);

    await expect(run()).rejects.toThrow(
      t("error.package_member_cap", {
        max_quantity: 1,
        name: "Solo Seat",
        quantity: 2,
      }),
    );
  });
});
