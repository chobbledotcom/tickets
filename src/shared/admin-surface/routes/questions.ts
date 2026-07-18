import { moveRoutes, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getQuestionsByIdDelete",
    "questions",
    "GET",
    "/admin/questions/:id/delete",
  ),
  route(
    "postQuestionsByIdDelete",
    "questions",
    "POST",
    "/admin/questions/:id/delete",
  ),
  route("getQuestions", "questions", "GET", "/admin/questions"),
  route("getQuestionsById", "questions", "GET", "/admin/questions/:id"),
  route(
    "getQuestionsByIdAnswersByAnswerIdDelete",
    "questions",
    "GET",
    "/admin/questions/:id/answers/:answerId/delete",
  ),
  route(
    "getQuestionsByIdAnswersByAnswerIdEdit",
    "questions",
    "GET",
    "/admin/questions/:id/answers/:answerId/edit",
  ),
  route(
    "getQuestionsByIdAnswersByAnswerIdRecalculate",
    "questions",
    "GET",
    "/admin/questions/:id/answers/:answerId/recalculate",
  ),
  route(
    "postListingByIdQuestions",
    "questions",
    "POST",
    "/admin/listing/:id/questions",
  ),
  route("postQuestions", "questions", "POST", "/admin/questions"),
  route(
    "postQuestionsByIdAnswers",
    "questions",
    "POST",
    "/admin/questions/:id/answers",
  ),
  route(
    "postQuestionsByIdAnswersByAnswerIdDelete",
    "questions",
    "POST",
    "/admin/questions/:id/answers/:answerId/delete",
  ),
  route(
    "postQuestionsByIdAnswersByAnswerIdEdit",
    "questions",
    "POST",
    "/admin/questions/:id/answers/:answerId/edit",
  ),
  ...moveRoutes(
    "postQuestionsByIdAnswersByAnswerId",
    "questions",
    "/admin/questions/:id/answers/:answerId",
  ),
  route(
    "postQuestionsByIdAnswersByAnswerIdRecalculate",
    "questions",
    "POST",
    "/admin/questions/:id/answers/:answerId/recalculate",
  ),
  route(
    "postQuestionsByIdEdit",
    "questions",
    "POST",
    "/admin/questions/:id/edit",
  ),
  route(
    "postQuestionsByIdListings",
    "questions",
    "POST",
    "/admin/questions/:id/listings",
  ),
  ...moveRoutes("postQuestionsById", "questions", "/admin/questions/:id"),
] as const;
