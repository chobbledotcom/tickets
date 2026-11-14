import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Questions - assign_all", { db: true }, () => {
  test("an update can turn assign_all off", async () => {
    const created = await assertJson(
      apiRequest("/api/admin/questions", {
        body: { assign_all: true, display_type: "radio", text: "Everywhere?" },
        method: "POST",
      }),
      201,
    );
    const id = created.question.id as number;

    await assertJson(
      apiRequest(`/api/admin/questions/${id}`, {
        body: { assign_all: false },
        method: "PUT",
      }),
      200,
      (body) => {
        expect(body.question.assign_all).toBe(false);
      },
    );
  });
});
