import { modifierAccount } from "#accounting/accounts.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { logActivity } from "#db/activity-log.ts";
import { groups } from "#db/groups.ts";
import { getAllListings } from "#db/listings/records.ts";
import {
  adjustModifierRevenue,
  getModifier,
  getModifierAggregateRecalculation,
  getModifierAnswerIds,
  MODIFIER_AGGREGATE_FIELDS,
  type ModifierAggregateValues,
  type ModifierInput,
  modifierAggregates,
  modifierGroups,
  modifierListings,
} from "#db/modifiers.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { t } from "#i18n";
import {
  createRecalculateHandlers,
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  recalculateRoute,
} from "#routes/admin/aggregate-recalculation.ts";
import type { EditEntityPage } from "#routes/admin/entity-write-tab.ts";
import { loadAccountLedger } from "#routes/admin/ledger/statements.ts";
import { defineAdminRoutes, recordRoutes } from "#routes/admin/route-tables.ts";
import { type AuthSession, withAuth } from "#routes/auth.ts";
import { adminRedirect, notFoundResponse } from "#routes/response.ts";
import { formPolicyAt } from "#routes/route-gates.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { toMinorUnits } from "#shared/currency.ts";
import type { FormParams } from "#shared/form-data.ts";
import { checkedValues } from "#shared/forms/validation.ts";
import { matchKey } from "#shared/keys.ts";
import { validateCalcValue } from "#shared/price-modifier.ts";
import { modifierRecord } from "#shared/records/modifiers.ts";
import { standardRecordPages } from "#shared/rest/record-pages.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
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
} from "#templates/admin/modifiers/pages.tsx";
import { guideFooterSlot } from "#templates/components/actions.tsx";
import { getModifierAggregateFields } from "#templates/fields/aggregate.ts";
import {
  getModifierForm,
  type ModifierFormValues,
} from "#templates/fields/modifier.ts";
import type { Modifier } from "#types";
import { withEntityLoader } from "./entity-handlers.ts";
import { handleAnswerLinks, handleScopeLinks } from "./modifier-links.ts";
import { makeMoneyAdjustHandler } from "./money-adjust.ts";
import { recordEditPage } from "./record-edit-page.ts";

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
    codeIndex: code ? await hmacHash(matchKey(code)) : null,
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

const modifierPage: EditEntityPage<Modifier> = recordEditPage(modifierRecord, {
  deleteDestination: "modifierDelete",
  deleteLabelKey: "modifiers.delete.submit",
  destination: "modifier",
  edit: (modifier, ctx, rejected) =>
    loadModifierEditPanel(
      modifier,
      ctx.session,
      rejected?.error,
      rejected?.form.toRenderValues(),
    ),
  guideFooter: guideFooterSlot(
    "/admin/guide#modifiers",
    "modifiers.guide_link",
  ),
  navActive: { section: adminPattern("modifiers") },
});

// The list and edit pages load the ledger-projected Modifier. The delete
// confirmation and every write use the stored ModifierRow.
const pages = standardRecordPages(
  modifierRecord,
  getModifierForm(),
  t("modifiers.name_label"),
  adminModifierDeletePage,
  modifierPage.renderEditError,
  adminModifiersPage,
  adminModifierNewPage,
  "Modifier",
  extractModifierInput,
  modifierValuesError,
);

const withModifier = withEntityLoader(getModifier);

/** Parse the edit form the way the standard page door does: the schema, then
 * the cross-field value rule, then the record's input. */
const modifierEditInput = async (
  form: FormParams,
): Promise<Result<ModifierInput>> => {
  const parsed = checkedValues(
    getModifierForm().validate(form),
    modifierValuesError,
  );
  return parsed.ok
    ? okResult(await extractModifierInput(parsed.value))
    : parsed;
};

/** The running totals the edit form carries, if any, or the error to render. */
const modifierEditAggregates = (
  form: FormParams,
): Result<ModifierAggregateValues | null> => {
  const aggregates = parseEditableAggregateForm<ModifierAggregateValues>(
    form,
    getModifierAggregateFields(),
  );
  return aggregates.ok
    ? okResult(aggregates.input)
    : errorResult(aggregates.error);
};

/** Write the edited row through the record, then save the running totals that
 * ride outside its input. */
const applyModifierEdit = async (
  id: number,
  session: AuthSession,
  form: FormParams,
  input: ModifierInput,
  aggregates: ModifierAggregateValues | null,
): Promise<Response> => {
  const result = await modifierRecord.update(id, input);
  if (result.kind === "written") {
    if (aggregates) await modifierAggregates.update(id, aggregates);
    return adminRedirect("modifiers", {}, t("modifiers.updated"), true);
  }
  return result.kind === "not-found"
    ? notFoundResponse()
    : modifierPage.renderEditError(id, session, form, result.message);
};

/** The edit POST also saves the running totals, which are not part of the
 * record's input. The record's one write still owns the row and its log. */
const handleEditPost: TypedRouteHandler<"POST /admin/modifiers/:id/edit"> = (
  request,
  { id },
) =>
  withAuth(
    request,
    formPolicyAt("/admin/modifiers/:id/edit"),
    async (session, form) => {
      const modifier = await getModifier(id);
      if (!modifier) return notFoundResponse();
      const aggregates = modifierEditAggregates(form);
      if (!aggregates.ok) {
        return modifierPage.renderEditError(
          id,
          session,
          form,
          aggregates.error,
        );
      }
      const parsed = await modifierEditInput(form);
      if (!parsed.ok) {
        return modifierPage.renderEditError(id, session, form, parsed.error);
      }
      return applyModifierEdit(
        id,
        session,
        form,
        parsed.value,
        aggregates.value,
      );
    },
  );

/**
 * Post a manual `writeoff` adjustment so the modifier's projected revenue
 * matches the owner-entered figure. Owner-only. The delta is computed from
 * the modifier's current projected `total_revenue`, which can be negative for
 * a net discount.
 */
const adjustModifierRevenueForm = makeMoneyAdjustHandler<Modifier>({
  adjust: (modifier, target) => adjustModifierRevenue(modifier.id, target),
  editPath: (id) => `/admin/modifiers/${id}/edit`,
  field: "total_revenue",
  load: getModifier,
  logMessage: (modifier) => `Modifier '${modifier.name}' revenue adjusted`,
  pattern: "/admin/modifiers/:id/revenue",
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
  pattern: "/admin/modifiers/recalculate/:modifierId",
  render: renderModifierRecalculatePage,
  reset: modifierAggregates.reset,
  successMessage: t("modifiers.recalculate.success"),
  successPath: (modifier) => `/admin/modifiers/${modifier.id}/edit`,
  withEntity: withModifier,
});

const handleModifierRecalculateGet: TypedRouteHandler<"GET /admin/modifiers/recalculate/:modifierId"> =
  recalculateRoute(modifierRecalculateHandlers.get)("modifierId");

const handleModifierRecalculatePost: TypedRouteHandler<"POST /admin/modifiers/recalculate/:modifierId"> =
  recalculateRoute(modifierRecalculateHandlers.post)("modifierId");

/** Modifier routes. The edit POST restates the standard key with its own
 * handler. */
export const adminHandlers = defineAdminRoutes({
  ...recordRoutes(
    adminPattern("modifiers"),
    adminPattern("modifier"),
    pages,
    modifierPage,
  ),
  "GET /admin/modifiers/recalculate/:modifierId": handleModifierRecalculateGet,
  "POST /admin/modifiers/:id/answers": handleAnswerLinks,
  "POST /admin/modifiers/:id/edit": handleEditPost,
  "POST /admin/modifiers/:id/links": handleScopeLinks,
  "POST /admin/modifiers/:id/revenue": handleRevenueAdjust,
  "POST /admin/modifiers/recalculate/:modifierId":
    handleModifierRecalculatePost,
});
