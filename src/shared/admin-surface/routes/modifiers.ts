import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getModifiersByIdDelete",
    "modifiers",
    "GET",
    "/admin/modifiers/:id/delete",
  ),
  route(
    "postModifiersByIdDelete",
    "modifiers",
    "POST",
    "/admin/modifiers/:id/delete",
  ),
  route("getModifiers", "modifiers", "GET", "/admin/modifiers"),
  route("getModifiersNew", "modifiers", "GET", "/admin/modifiers/new"),
  route("postModifiers", "modifiers", "POST", "/admin/modifiers"),
  route(
    "postModifiersByIdEdit",
    "modifiers",
    "POST",
    "/admin/modifiers/:id/edit",
  ),
  route(
    "getModifiersByIdEdit",
    "modifiers",
    "GET",
    "/admin/modifiers/:id/edit",
  ),
  route(
    "getModifiersRecalculateByModifierId",
    "modifiers",
    "GET",
    "/admin/modifiers/recalculate/:modifierId",
  ),
  route(
    "postModifiersByIdAnswers",
    "modifiers",
    "POST",
    "/admin/modifiers/:id/answers",
  ),
  route(
    "postModifiersByIdLinks",
    "modifiers",
    "POST",
    "/admin/modifiers/:id/links",
  ),
  route(
    "postModifiersByIdRevenue",
    "modifiers",
    "POST",
    "/admin/modifiers/:id/revenue",
  ),
  route(
    "postModifiersRecalculateByModifierId",
    "modifiers",
    "POST",
    "/admin/modifiers/recalculate/:modifierId",
  ),
] as const;
