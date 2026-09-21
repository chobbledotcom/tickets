/* jscpd:ignore-start */

import { modifierAccount } from "#accounting/accounts.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { logActivity } from "#db/activity-log.ts";
import { groups } from "#db/groups.ts";
import { getAllListings } from "#db/listings/records.ts";
import {
  adjustModifierRevenue,
  getAllModifiers,
  getModifier,
  getModifierAggregateRecalculation,
  getModifierAnswerIds,
  MODIFIER_AGGREGATE_FIELDS,
  type ModifierAggregateValues,
  type ModifierInput,
  type ModifierRow,
  modifierAggregates,
  modifierGroups,
  modifierListings,
  modifiersTable,
} from "#db/modifiers.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { once } from "#fp";
import { t } from "#i18n";
import {
  createRecalculateHandlers,
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
} from "#routes/admin/aggregate-recalculation.ts";
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import {
  defineEditEntityPage,
  type EditEntityPage,
} from "#routes/admin/entity-write-tab.ts";
import { loadAccountLedger } from "#routes/admin/ledger/statements.ts";
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { notFoundResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { normalizeCode, validateCalcValue } from "#shared/price-modifier.ts";
import { defineResource } from "#shared/rest/resource.ts";
import { exceedsCurrencyPrecision } from "#shared/validation/money.ts";
import { adminModifierRecalculatePage } from "#templates/admin/modifiers/aggregates.tsx";
import type {
  AnswerLinks,
  ScopeLinks,
} from "#templates/admin/modifiers/links.tsx";
import {
  adminModifierDeletePage,
  adminModifierNewPage,
  adminModifiersPage,
  ModifierEditPanel,
  ModifiersGuideFooter,
} from "#templates/admin/modifiers/pages.tsx";
import { getModifierAggregateFields } from "#templates/fields/aggregate.ts";
import {
  getModifierForm,
  type ModifierFormValues,
} from "#templates/fields/modifier.ts";
import type { Modifier } from "#types";
import { withEntityLoader } from "./entity-handlers.ts";
import { childAddOnSaveError } from "./modifier-add-on-reachability.ts";
import { handleAnswerLinks, handleScopeLinks } from "./modifier-links.ts";
import { makeMoneyAdjustHandler } from "./money-adjust.ts";

/* jscpd:ignore-end */

/** Build modifier input from validated form values. The value is stored as
 * the positive magnitude the owner typed. The signed engine value is
 * computed where modifiers are applied to a checkout. A promo code is kept
 * only for "code" modifiers, with its blind index computed for public
 * lookup. The per-order cap is kept only for "answer" modifiers, so a
 * modifier moved away from that trigger loses its stale cap. */
const extractModifierInput = async (
  values: ModifierFormValues,
): Promise<ModifierInput> => {
  const code = values.trigger === "code" ? values.code.trim() : "";
  return {
    active: values.active === "1",
    calcKind: values.calc_kind,
    calcValue: values.calc_value,
    code,
    codeIndex: code ? await hmacHash(normalizeCode(code)) : null,
    direction: values.direction,
    maxPerOrder: values.trigger === "answer" ? values.max_per_order : null,
    minSubtotal: toMinorUnits(values.min_subtotal),
    minVisits: values.min_visits,
    name: values.name,
    scope: values.scope,
    stock: values.stock,
    trigger: values.trigger,
  };
};

const childAddOnInputError = async (
  input: ModifierInput,
  id: number | undefined,
): Promise<string | null> => {
  if (input.trigger !== "optional" || input.active !== true) return null;
  // Resolve from the stored links (an edit doesn't change them; a create has
  // none). `resolveAddOnScope` keeps only the set matching the input's scope.
  const [listingIds, groupIds] = await Promise.all([
    id === undefined ? [] : modifierListings.getIds(id),
    id === undefined ? [] : modifierGroups.getIds(id),
  ]);
  return childAddOnSaveError({
    active: true,
    groupIds,
    listingIds,
    name: input.name,
    scope: input.scope,
    trigger: "optional",
  });
};

const modifierValuesError = (values: ModifierFormValues): string | null => {
  const valueError = validateCalcValue(
    values.calc_kind,
    values.calc_value,
    values.direction,
  );
  if (valueError) return t(valueError);
  return values.calc_kind === "fixed" &&
    exceedsCurrencyPrecision(values.calc_value)
    ? "Amount has more decimal places than your currency allows"
    : null;
};

const validateModifier = (
  input: ModifierInput,
  id?: number,
): Promise<string | null> => {
  if (input.trigger === "code" && !input.code) {
    return Promise.resolve("A promo-code modifier needs a code");
  }
  if (
    input.minVisits !== undefined &&
    (!Number.isInteger(input.minVisits) || input.minVisits < 0)
  ) {
    return Promise.resolve(
      "Minimum previous bookings must be a whole number of 0 or more",
    );
  }
  if (
    input.maxPerOrder !== undefined &&
    input.maxPerOrder !== null &&
    (!Number.isInteger(input.maxPerOrder) || input.maxPerOrder < 1)
  ) {
    return Promise.resolve(
      "Max times per order must be a whole number of 1 or more",
    );
  }
  const isOptionalAddOn = input.trigger === "optional";
  const requiresPreviousBookings = Number(input.minVisits) > 0;
  if (isOptionalAddOn && requiresPreviousBookings) {
    return Promise.resolve("Optional add-ons cannot require previous bookings");
  }
  return childAddOnInputError(input, id);
};

const getModifiersResource = once(() =>
  defineResource<ModifierRow, ModifierInput, number, ModifierFormValues>({
    form: getModifierForm(),
    table: modifiersTable,
    toInput: extractModifierInput,
    validate: validateModifier,
    validateValues: modifierValuesError,
  }),
);

const scopeLinksFor = async (
  modifier: Modifier,
): Promise<ScopeLinks | null> => {
  if (modifier.scope === "listings") {
    const listings = await getAllListings();
    return {
      kind: "listings",
      options: listings.map((l) => ({
        active: l.active,
        id: l.id,
        name: l.name,
      })),
      selected: await modifierListings.getIds(modifier.id),
    };
  }
  if (modifier.scope === "groups") {
    const allGroups = await groups.cache.getAll();
    // Groups have no deactivated state, so every group option is active.
    return {
      kind: "groups",
      options: allGroups.map((g) => ({ active: true, id: g.id, name: g.name })),
      selected: await modifierGroups.getIds(modifier.id),
    };
  }
  return null;
};

const answerLinksFor = async (
  modifier: Modifier,
): Promise<AnswerLinks | null> => {
  if (modifier.trigger !== "answer") return null;
  const [questions, selected] = await Promise.all([
    getAllQuestionsWithAnswers(),
    getModifierAnswerIds(modifier.id),
  ]);
  return {
    options: questions.flatMap((q) =>
      q.answers.map((a) => ({ id: a.id, name: `${q.text} — ${a.text}` })),
    ),
    selected,
  };
};

const loadModifierLedgerForSession = (
  session: { adminLevel: string },
  modifier: Modifier,
) => {
  if (session.adminLevel !== "owner") return Promise.resolve(undefined);
  return loadAccountLedger(modifierAccount(modifier.id));
};

const loadModifierEditPanel = async (
  modifier: Modifier,
  session: { adminLevel: string },
  error?: string,
  values?: Record<string, string | number | null>,
): Promise<JSX.Element> => {
  const [links, answerLinks, ledger] = await Promise.all([
    scopeLinksFor(modifier),
    answerLinksFor(modifier),
    loadModifierLedgerForSession(session, modifier),
  ]);
  return ModifierEditPanel({
    answerLinks,
    links,
    modifier,
    ...(error ? { error } : {}),
    ...(ledger ? { ledger } : {}),
    ...(values ? { values } : {}),
  });
};

const modifierPage: EditEntityPage<Modifier> = defineEditEntityPage({
  deleteLabelKey: "modifiers.delete.submit",
  destination: "modifier",
  edit: (modifier, ctx, rejected) =>
    loadModifierEditPanel(
      modifier,
      ctx.session,
      rejected?.error,
      rejected?.form.toRenderValues(),
    ),
  guideFooter: () => Promise.resolve(ModifiersGuideFooter()),
  load: (id) => getModifier(id),
  navActive: { section: adminPattern("modifiers") },
});

// The list and entity page load the ledger-projected Modifier; writes and the
// delete confirmation use the stored ModifierRow.
const crud = createCrudHandlers({
  getAll: getAllModifiers,
  getName: (m: ModifierRow) => m.name,
  list: "modifiers",
  operations: getModifiersResource,
  renderDelete: adminModifierDeletePage,
  renderEditError: modifierPage.renderEditError,
  renderList: adminModifiersPage,
  renderNew: adminModifierNewPage,
  singular: "Modifier",
});

const withModifier = withEntityLoader(getModifier);

const handleEditPost: TypedRouteHandler<"POST /admin/modifiers/:id/edit"> = (
  request,
  { id },
) =>
  withAuth(request, AUTH_FORM, async (_session, form) => {
    const modifier = await getModifier(id);
    if (!modifier) return notFoundResponse();
    const aggregates = parseEditableAggregateForm<ModifierAggregateValues>(
      form,
      getModifierAggregateFields(),
    );
    if (!aggregates.ok) {
      return modifierPage.renderEditError(id, _session, form, aggregates.error);
    }
    const result = await getModifiersResource().update(id, form);
    if (result.ok) {
      if (aggregates.input) {
        await modifierAggregates.update(id, aggregates.input);
      }
      await logActivity(`Modifier '${result.row.name}' updated`);
      return redirect("/admin/modifiers", "Modifier updated", true);
    }
    if ("notFound" in result) return notFoundResponse();
    return modifierPage.renderEditError(id, _session, form, result.error);
  });

/**
 * Handle POST /admin/modifiers/:id/revenue — post a manual `writeoff` adjustment
 * so the modifier's projected revenue matches the owner-entered figure
 * (decision 14). Owner-only; the delta is computed from the modifier's current
 * projected `total_revenue` (which may be negative for a net discount).
 */
const adjustModifierRevenueForm = makeMoneyAdjustHandler<Modifier>({
  adjust: (modifier, target) => adjustModifierRevenue(modifier.id, target),
  editPath: (id) => `/admin/modifiers/${id}/edit`,
  field: "total_revenue",
  load: getModifier,
  logMessage: (modifier) => `Modifier '${modifier.name}' revenue adjusted`,
  successMessage: t("modifiers.adjust_revenue_success"),
});

/** Handle POST /admin/modifiers/:id/revenue */
const handleRevenueAdjust: TypedRouteHandler<
  "POST /admin/modifiers/:id/revenue"
> = (request, { id }) => adjustModifierRevenueForm(request, id);

const renderModifierRecalculatePage = createRecalculatePageRenderer(
  getModifierAggregateRecalculation,
  adminModifierRecalculatePage,
);

const modifierRecalculateHandlers = createRecalculateHandlers({
  chooseMessage: t("modifiers.recalculate.choose"),
  entityId: (modifier) => modifier.id,
  fields: MODIFIER_AGGREGATE_FIELDS,
  log: (modifier) =>
    logActivity(`Modifier '${modifier.name}' totals recalculated`),
  render: renderModifierRecalculatePage,
  reset: modifierAggregates.reset,
  successMessage: t("modifiers.recalculate.success"),
  successPath: (modifier) => `/admin/modifiers/${modifier.id}/edit`,
  withEntity: withModifier,
});

const handleModifierRecalculateGet: TypedRouteHandler<
  "GET /admin/modifiers/recalculate/:modifierId"
> = (request, { modifierId }) =>
  modifierRecalculateHandlers.get(request, modifierId);

const handleModifierRecalculatePost: TypedRouteHandler<
  "POST /admin/modifiers/recalculate/:modifierId"
> = (request, { modifierId }) =>
  modifierRecalculateHandlers.post(request, modifierId);

/** Modifier routes. The edit POST restates the standard key with its own
 * handler. */
export const adminHandlers = defineRoutes({
  ...crudRoutes(adminPattern("modifiers"), crud),
  ...entityTabRoutes(adminPattern("modifier"), modifierPage),
  "GET /admin/modifiers/recalculate/:modifierId": handleModifierRecalculateGet,
  "POST /admin/modifiers/:id/answers": handleAnswerLinks,
  "POST /admin/modifiers/:id/edit": handleEditPost,
  "POST /admin/modifiers/:id/links": handleScopeLinks,
  "POST /admin/modifiers/:id/revenue": handleRevenueAdjust,
  "POST /admin/modifiers/recalculate/:modifierId":
    handleModifierRecalculatePost,
});
