/** The modifier links save path: scoped listing/group links and answer links,
 * written for a loaded modifier and redirected back with a flash. The scope
 * save carries the child-add-on reachability guard. */

import {
  getModifier,
  modifierGroups,
  modifierListings,
  setModifierAnswers,
} from "#db/modifiers.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Modifier } from "#types";
import { childAddOnSaveError } from "./modifier-add-on-reachability.ts";

/** Selected ids from a checkbox group, positive integers only. */
const selectedIds = (form: FormParams, field: string): number[] =>
  form
    .getAll(field)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

/** Run a modifier-link save (scope or answer) for the loaded modifier, then
 * redirect back to its edit page with a flash. Shared by the scope and answer
 * link forms so the auth/load/redirect boilerplate lives once. An optional
 * `guard` runs before the write and, when it returns a message, blocks the save
 * with that error instead (e.g. the child-only add-on reachability check). */
const saveModifierLinks = (
  request: Request,
  id: number,
  save: (modifier: Modifier, form: FormParams) => Promise<unknown>,
  message: string,
  guard?: (modifier: Modifier, form: FormParams) => Promise<string | null>,
): Promise<Response> =>
  createAuthedHandler<{ id: number }, Modifier>({
    handle: async ({ context: modifier, form }) => {
      const error = guard ? await guard(modifier, form) : null;
      if (error) return errorRedirect(`/admin/modifiers/${id}/edit`, error);
      await save(modifier, form);
      return redirect(`/admin/modifiers/${modifier.id}/edit`, message, true);
    },
    loadContext: ({ id: modifierId }) => getModifier(modifierId),
  })(request, { id });

/** Write a scoped modifier's listing/group links from the submitted form. */
const writeScopeLinks = (
  modifier: Modifier,
  form: FormParams,
): Promise<unknown> => {
  if (modifier.scope === "listings") {
    return modifierListings.setIds(
      modifier.id,
      selectedIds(form, "listing_ids"),
    );
  }
  if (modifier.scope === "groups") {
    return modifierGroups.setIds(modifier.id, selectedIds(form, "group_ids"));
  }
  return Promise.resolve();
};

/** Block a scope-links save that would leave an opt-in add-on reachable only
 * through a suppressed child (parents feature on), from the submitted links. */
const scopeLinksChildGuard = (
  modifier: Modifier,
  form: FormParams,
): Promise<string | null> =>
  childAddOnSaveError({
    active: modifier.active,
    groupIds: selectedIds(form, "group_ids"),
    listingIds: selectedIds(form, "listing_ids"),
    name: modifier.name,
    scope: modifier.scope,
    trigger: modifier.trigger,
  });

/** POST handler that saves a scoped modifier's listing/group links — blocked
 * when the new scope would leave an opt-in add-on reachable only through a
 * suppressed child (parents feature on). */
export const handleScopeLinks: TypedRouteHandler<
  "POST /admin/modifiers/:id/links"
> = (request, { id }) =>
  saveModifierLinks(
    request,
    id,
    writeScopeLinks,
    "Scope updated",
    scopeLinksChildGuard,
  );

/** POST handler that saves an answer-triggered modifier's answer links. */
export const handleAnswerLinks: TypedRouteHandler<
  "POST /admin/modifiers/:id/answers"
> = (request, { id }) =>
  saveModifierLinks(
    request,
    id,
    (modifier, form) =>
      setModifierAnswers(modifier.id, selectedIds(form, "answer_ids")),
    "Answers updated",
  );
