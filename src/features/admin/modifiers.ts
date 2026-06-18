/**
 * Admin price-modifier management routes — accessible to owners and managers.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  selectedRecalculationFields,
} from "#routes/admin/aggregate-recalculation.ts";
import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllGroups } from "#shared/db/groups.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  getAllModifiers,
  getModifierAggregateRecalculation,
  getModifierGroupIds,
  getModifierListingIds,
  MODIFIER_AGGREGATE_FIELDS,
  type ModifierAggregateValues,
  type ModifierInput,
  modifiersTable,
  resetModifierAggregateFields,
  setModifierGroups,
  setModifierListings,
  updateModifierAggregateValues,
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
  adminModifierRecalculatePage,
  adminModifiersPage,
  type ScopeLinks,
} from "#templates/admin/modifiers.tsx";
import type {
  ModifierAggregateFormValues,
  ModifierFormValues,
} from "#templates/fields.ts";
import { modifierAggregateFields, modifierFields } from "#templates/fields.ts";
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
    minVisits: values.min_visits,
    name: values.name,
    scope: values.scope as ModifierScope,
    stock: values.stock,
    trigger: values.trigger as ModifierTrigger,
  };
};

const extractModifierAggregateValues = (
  values: ModifierAggregateFormValues,
): ModifierAggregateValues => ({
  total_revenue: toMinorUnits(Number.parseFloat(values.total_revenue)),
  total_uses: values.total_uses,
  usage_count: values.usage_count,
});

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
  if (
    input.minVisits !== undefined &&
    (!Number.isInteger(input.minVisits) || input.minVisits < 0)
  ) {
    return Promise.resolve(
      "Minimum previous bookings must be a whole number of 0 or more",
    );
  }
  const isOptionalAddOn = input.trigger === "optional";
  const requiresPreviousBookings = Number(input.minVisits) > 0;
  if (isOptionalAddOn && requiresPreviousBookings) {
    return Promise.resolve("Optional add-ons cannot require previous bookings");
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
      const flash = applyFlash(request);
      const links = await scopeLinksFor(modifier);
      return htmlResponse(
        adminModifierEditPage(
          modifier,
          session,
          flash.error,
          links,
          flash.success,
        ),
      );
    }),
  );

const handleEditPost: TypedRouteHandler<"POST /admin/modifiers/:id/edit"> = (
  request,
  { id },
) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    const modifier = await modifiersTable.findById(id);
    if (!modifier) return notFoundResponse();
    const aggregates = parseEditableAggregateForm<
      ModifierAggregateFormValues,
      ModifierAggregateValues
    >(form, modifierAggregateFields, extractModifierAggregateValues);
    if (!aggregates.ok) {
      return errorRedirect(`/admin/modifiers/${id}/edit`, aggregates.error);
    }
    const result = await modifiersResource.update(id, form);
    if (result.ok) {
      if (aggregates.input) {
        await updateModifierAggregateValues(id, aggregates.input);
      }
      await logActivity(`Modifier '${result.row.name}' updated`);
      return redirect("/admin/modifiers", "Modifier updated", true);
    }
    if ("notFound" in result) return notFoundResponse();
    return errorRedirect(`/admin/modifiers/${id}/edit`, result.error);
  });

const renderModifierRecalculatePage = createRecalculatePageRenderer(
  getModifierAggregateRecalculation,
  adminModifierRecalculatePage,
);

const handleModifierRecalculateGet: TypedRouteHandler<
  "GET /admin/modifiers/recalculate/:modifierId"
> = (request, { modifierId }) =>
  requireSessionOr(request, (session) =>
    withModifier(modifierId)((modifier) => {
      applyFlash(request);
      const flash = getFlash();
      return renderModifierRecalculatePage(
        modifier,
        session,
        flash.error,
        flash.success,
      );
    }),
  );

const handleModifierRecalculatePost: TypedRouteHandler<
  "POST /admin/modifiers/recalculate/:modifierId"
> = (request, { modifierId }) =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withModifier(modifierId)(async (modifier) => {
      const selected = selectedRecalculationFields(
        form,
        MODIFIER_AGGREGATE_FIELDS,
      );
      if (selected.length === 0) {
        return renderModifierRecalculatePage(
          modifier,
          session,
          t("modifiers.recalculate.choose"),
        );
      }
      await resetModifierAggregateFields(modifier.id, selected);
      await logActivity(`Modifier '${modifier.name}' totals recalculated`);
      return redirect(
        `/admin/modifiers/${modifier.id}/edit`,
        t("modifiers.recalculate.success"),
        true,
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
    "GET /admin/modifiers/recalculate/:modifierId":
      handleModifierRecalculateGet,
    "POST /admin/modifiers/:id/edit": handleEditPost,
    "POST /admin/modifiers/:id/links": handleScopeLinks,
    "POST /admin/modifiers/recalculate/:modifierId":
      handleModifierRecalculatePost,
  }),
};
