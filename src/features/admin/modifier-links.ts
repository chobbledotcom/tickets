/* jscpd:ignore-start -- imports */
import {
  getModifier,
  modifierGroups,
  modifierListings,
  setModifierAnswers,
} from "#db/modifiers.ts";
import { formPolicyFor } from "#routes/auth.ts";
import { adminRedirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Modifier } from "#types";
import { childAddOnSaveError } from "./modifier-add-on-reachability.ts";

/* jscpd:ignore-end */

/** Selected ids from a checkbox group, positive integers only. A value that is
 *  not a plain whole number is dropped. */
const selectedIds = (form: FormParams, field: string): number[] =>
  form.getNumberArray(field);

/** Run a modifier-link save (scope or answer) for the loaded modifier, then
 * redirect back to its edit page with a flash. Shared by the scope and answer
 * link forms so the auth/load/redirect boilerplate lives once. An optional
 * `guard` runs before the write. A returned message blocks the save with that
 * error instead, for example the child-only add-on reachability check. */
const saveModifierLinks = (
  pattern: string,
  request: Request,
  id: number,
  save: (modifier: Modifier, form: FormParams) => Promise<unknown>,
  message: string,
  guard?: (modifier: Modifier, form: FormParams) => Promise<string | null>,
): Promise<Response> => {
  const route = adminDestinationAt(pattern);
  return createAuthedHandler<{ id: number }, Modifier>({
    auth: formPolicyFor(route),
    handle: async ({ context: modifier, form }) => {
      const error = guard ? await guard(modifier, form) : null;
      if (error) return adminRedirect("modifierEdit", { id }, error, false);
      await save(modifier, form);
      return adminRedirect("modifierEdit", { id: modifier.id }, message, true);
    },
    loadContext: ({ id: modifierId }) => getModifier(modifierId),
  })(request, { id });
};

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

/** Block a scope-links save that leaves an opt-in add-on reachable only
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

export const handleScopeLinks: TypedRouteHandler<
  "POST /admin/modifiers/:id/links"
> = (request, { id }) =>
  saveModifierLinks(
    "/admin/modifiers/:id/links",
    request,
    id,
    writeScopeLinks,
    "Scope updated",
    scopeLinksChildGuard,
  );

export const handleAnswerLinks: TypedRouteHandler<
  "POST /admin/modifiers/:id/answers"
> = (request, { id }) =>
  saveModifierLinks(
    "/admin/modifiers/:id/answers",
    request,
    id,
    (modifier, form) =>
      setModifierAnswers(modifier.id, selectedIds(form, "answer_ids")),
    "Answers updated",
  );
