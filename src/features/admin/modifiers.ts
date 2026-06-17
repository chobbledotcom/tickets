/**
 * Admin price-modifier management routes — accessible to owners and managers.
 */

/* jscpd:ignore-start */
import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { getAllGroups } from "#shared/db/groups.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  getAllModifiers,
  getModifierGroupIds,
  getModifierListingIds,
  type ModifierInput,
  modifiersTable,
  setModifierGroups,
  setModifierListings,
} from "#shared/db/modifiers.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  type CalcKind,
  isCalcKind,
  isModifierDirection,
  isModifierScope,
  isModifierTrigger,
  type ModifierDirection,
  type ModifierScope,
  type ModifierTrigger,
  normalizeCode,
  validateCalcValue,
} from "#shared/price-modifier.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import type { Modifier } from "#shared/types.ts";
import {
  adminModifierDeletePage,
  adminModifierEditPage,
  adminModifierNewPage,
  adminModifiersPage,
  type ScopeLinks,
} from "#templates/admin/modifiers.tsx";
import type { ModifierFormValues } from "#templates/fields.ts";
import { modifierFields } from "#templates/fields.ts";
import { withEntityLoader } from "./entity-handlers.ts";

/* jscpd:ignore-end */

/** Build modifier input from validated form values. The value is stored as the
 * positive magnitude the owner typed; converting it to the signed engine value
 * happens where modifiers are applied to a checkout. A promo code is kept only
 * for "code" modifiers, with its blind index computed for public lookup. */
const extractModifierInput = async (
  values: ModifierFormValues,
): Promise<ModifierInput> => {
  const code = values.trigger === "code" ? values.code.trim() : "";
  return {
    active: values.active === "1",
    calcKind: values.calc_kind as CalcKind,
    calcValue: values.calc_value,
    code,
    codeIndex: code ? await hmacHash(normalizeCode(code)) : null,
    direction: values.direction as ModifierDirection,
    minSubtotal: toMinorUnits(values.min_subtotal),
    name: values.name,
    scope: values.scope as ModifierScope,
    stock: values.stock,
    trigger: values.trigger as ModifierTrigger,
  };
};

/** Validate a modifier's kind, direction, trigger, scope, and value (the select
 * options can be bypassed by a crafted POST, so re-check membership here). */
const validateModifier = (input: ModifierInput): Promise<string | null> => {
  if (!isCalcKind(input.calcKind)) {
    return Promise.resolve("Invalid modifier type");
  }
  if (!isModifierDirection(input.direction)) {
    return Promise.resolve("Invalid direction");
  }
  if (input.trigger !== undefined && !isModifierTrigger(input.trigger)) {
    return Promise.resolve("Invalid trigger");
  }
  if (input.trigger === "code" && !input.code) {
    return Promise.resolve("A promo-code modifier needs a code");
  }
  if (input.scope !== undefined && !isModifierScope(input.scope)) {
    return Promise.resolve("Invalid scope");
  }
  return Promise.resolve(validateCalcValue(input.calcKind, input.calcValue));
};

const modifiersResource = defineNamedResource<
  Modifier,
  ModifierInput,
  number,
  ModifierFormValues
>({
  fields: modifierFields,
  nameField: "name",
  table: modifiersTable,
  toInput: extractModifierInput,
  validate: validateModifier,
});

const crud = createCrudHandlers({
  getAll: getAllModifiers,
  getName: (m: Modifier) => m.name,
  listPath: "/admin/modifiers",
  renderDelete: adminModifierDeletePage,
  renderEdit: adminModifierEditPage,
  renderList: adminModifiersPage,
  renderNew: adminModifierNewPage,
  resource: modifiersResource,
  singular: "Modifier",
});

/** The candidate listings/groups + current links for the scope editor, or null
 * when the modifier applies to the whole order (no links to manage). */
const scopeLinksFor = async (
  modifier: Modifier,
): Promise<ScopeLinks | null> => {
  if (modifier.scope === "listings") {
    const listings = await getAllListings();
    return {
      kind: "listings",
      options: listings.map((l) => ({ id: l.id, name: l.name })),
      selected: await getModifierListingIds(modifier.id),
    };
  }
  if (modifier.scope === "groups") {
    const groups = await getAllGroups();
    return {
      kind: "groups",
      options: groups.map((g) => ({ id: g.id, name: g.name })),
      selected: await getModifierGroupIds(modifier.id),
    };
  }
  return null;
};

const withModifier = withEntityLoader(modifiersTable.findById);

/** Edit page with the scope link editor for listing/group-scoped modifiers. */
const handleEditGet: TypedRouteHandler<"GET /admin/modifiers/:id/edit"> = (
  request,
  { id },
) =>
  requireSessionOr(request, (session) =>
    withModifier(id)(async (modifier) => {
      applyFlash(request);
      const links = await scopeLinksFor(modifier);
      return htmlResponse(
        adminModifierEditPage(modifier, session, getFlash().error, links),
      );
    }),
  );

/** Selected ids from a checkbox group, positive integers only. */
const selectedIds = (form: FormParams, field: string): number[] =>
  form
    .getAll(field)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

/** POST handler that saves a scoped modifier's listing/group links. */
const handleScopeLinks: TypedRouteHandler<"POST /admin/modifiers/:id/links"> = (
  request,
  { id },
) =>
  createAuthedHandler<{ id: number }, Modifier>({
    handle: async ({ context: modifier, form }) => {
      if (modifier.scope === "listings") {
        await setModifierListings(
          modifier.id,
          selectedIds(form, "listing_ids"),
        );
      } else if (modifier.scope === "groups") {
        await setModifierGroups(modifier.id, selectedIds(form, "group_ids"));
      }
      return redirect(
        `/admin/modifiers/${modifier.id}/edit`,
        "Scope updated",
        true,
      );
    },
    loadContext: ({ id: modifierId }) => modifiersTable.findById(modifierId),
  })(request, { id });

/** Modifier routes */
export const modifiersRoutes = {
  ...crud.routes,
  ...defineRoutes({
    "GET /admin/modifiers/:id/edit": handleEditGet,
    "POST /admin/modifiers/:id/links": handleScopeLinks,
  }),
};
