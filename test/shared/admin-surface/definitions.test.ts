import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { moveRoutes } from "#shared/admin-surface/definitions.ts";

test("builds literal move-down and move-up POST routes", () => {
  const routes = moveRoutes(
    "postQuestionsByIdAnswersByAnswerId",
    "questions",
    "/admin/questions/:id/answers/:answerId",
  );
  const downId: "postQuestionsByIdAnswersByAnswerIdMoveDown" = routes[0].id;
  const upPath: "/admin/questions/:id/answers/:answerId/move-up" =
    routes[1].pattern;

  expect(downId).toBe("postQuestionsByIdAnswersByAnswerIdMoveDown");
  expect(upPath).toBe("/admin/questions/:id/answers/:answerId/move-up");
  expect(routes).toEqual([
    {
      area: "questions",
      id: "postQuestionsByIdAnswersByAnswerIdMoveDown",
      method: "POST",
      pattern: "/admin/questions/:id/answers/:answerId/move-down",
      readOnly: "block",
    },
    {
      area: "questions",
      id: "postQuestionsByIdAnswersByAnswerIdMoveUp",
      method: "POST",
      pattern: "/admin/questions/:id/answers/:answerId/move-up",
      readOnly: "block",
    },
  ]);
});
