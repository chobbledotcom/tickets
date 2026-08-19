/* jscpd:ignore-start */
import { once } from "#fp";
import { t } from "#i18n";
import {
  createRecalculateHandlers,
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
} from "#routes/admin/aggregate-recalculation.ts";
import {
  defineEditEntityPage,
  type EditEntityPage,
} from "#routes/admin/entity-write-tab.ts";
import { loadAccountLedger } from "#routes/admin/ledger/statements.ts";
import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import { modifierAccount } from "#shared/accounting/accounts.ts";
import { adminPath, adminPattern } from "#shared/admin-surface.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { groups, listingGroups } from "#shared/db/groups.ts";
import { getNonStandaloneChildIds } from "#shared/db/listing-parents.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import {
  childUnreachableAddOnError,
  type ListingGroupMembership,
  listingIdsInGroups,
  reachablePageIds,
  toListingGroupMembership,
} from "#shared/db/modifier-resolve.ts";
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
  modifierGroups,
  modifierListings,
  modifiersTable,
  resetModifierAggregateFields,
  setModifierAnswers,
  updateModifierAggregateValues,
} from "#shared/db/modifiers.ts";
import { getAllQuestionsWithAnswers } from "#shared/db/questions/queries.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  type ModifierScope,
  type ModifierTrigger,
  normalizeCode,
  validateCalcValue,
} from "#shared/price-modifier.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import type { Modifier } from "#shared/types.ts";
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
import { withEntityLoader } from "./entity-handlers.ts";
import { makeMoneyAdjustHandler } from "./money-adjust.ts";

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
    calcKind: values.calc_kind,
    calcValue: values.calc_value,
    code,
    codeIndex: code ? await hmacHash(normalizeCode(code)) : null,
    direction: values.direction,
    minSubtotal: toMinorUnits(values.min_subtotal),
    minVisits: values.min_visits,
    name: values.name,
    scope: values.scope,
    stock: values.stock,
    trigger: values.trigger,
  };
};

const extractModifierAggregateValues = (
  values: ModifierAggregateValues,
): ModifierAggregateValues => ({
  total_uses: values.total_uses,
  usage_count: values.usage_count,
});

const resolveAddOnScope = (
  scope: ModifierScope | undefined,
  listingIds: number[],
  groupIds: number[],
  allListings: ListingGroupMembership[],
): number[] | null => {
  if (scope === "listings") return listingIds;
  if (scope === "groups") return listingIdsInGroups(groupIds, allListings);
  return null;
};

type AddOnSaveCandidate = {
  active: boolean;
  trigger: ModifierTrigger;
  name: string;
  scope: ModifierScope | undefined;
  listingIds: number[];
  groupIds: number[];
};

const childAddOnSaveError = async (
  candidate: AddOnSaveCandidate,
): Promise<string | null> => {
  const allListings = await getAllListings();
  const allIds = allListings.map((listing) => listing.id);
  const [childIds, membership] = await Promise.all([
    getNonStandaloneChildIds(allIds),
    listingGroups.getIdsByKeys(allIds),
  ]);
  const membershipListings: ListingGroupMembership[] = allListings.map(
    (listing) => toListingGroupMembership(listing, membership),
  );
  // Only an ACTIVE listing that serves its own booking page can rescue a
  // child-only add-on. That is any active listing except a non-standalone child
  // (a `bookable_alone` child DOES serve its own page, so it counts): public
  // ticket contexts load active listings only (`withActiveListings`), so an
  // inactive listing serves nothing. `childIds` here is the narrowed
  // non-standalone set, so a flagged child is neither suppressed nor excluded.
  const reachableIds = reachablePageIds(allListings, childIds);
  return childUnreachableAddOnError(
    {
      active: candidate.active,
      name: candidate.name,
      scope: resolveAddOnScope(
        candidate.scope,
        candidate.listingIds,
        candidate.groupIds,
        membershipListings,
      ),
      trigger: candidate.trigger,
    },
    childIds,
    reachableIds,
  );
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
  const isOptionalAddOn = input.trigger === "optional";
  const requiresPreviousBookings = Number(input.minVisits) > 0;
  if (isOptionalAddOn && requiresPreviousBookings) {
    return Promise.resolve("Optional add-ons cannot require previous bookings");
  }
  return childAddOnInputError(input, id);
};

const getModifiersResource = once(() =>
  defineNamedResource<ModifierRow, ModifierInput, number, ModifierFormValues>({
    form: getModifierForm(),
    nameField: "name",
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
  basePath: (id) => adminPath("modifier", { id }),
  deleteLabelKey: "modifiers.delete.submit",
  edit: (modifier, ctx, rejected) =>
    loadModifierEditPanel(
      modifier,
      ctx.session,
      rejected?.error,
      rejected?.form.toRenderValues(),
    ),
  guard: requireSessionOr,
  guideFooter: () => Promise.resolve(ModifiersGuideFooter()),
  load: (id) => getModifier(id),
  navActive: { section: adminPattern("modifiers") },
});

// The list and entity page load the ledger-projected Modifier; writes and the
// delete confirmation use the stored ModifierRow.
const crud = createCrudHandlers({
  getAll: getAllModifiers,
  getName: (m: ModifierRow) => m.name,
  listPath: adminPattern("modifiers"),
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
    const aggregates = parseEditableAggregateForm<
      ModifierAggregateValues,
      ModifierAggregateValues
    >(form, getModifierAggregateFields(), extractModifierAggregateValues);
    if (!aggregates.ok) {
      return modifierPage.renderEditError(id, _session, form, aggregates.error);
    }
    const result = await getModifiersResource().update(id, form);
    if (result.ok) {
      if (aggregates.input) {
        await updateModifierAggregateValues(id, aggregates.input);
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
  reset: resetModifierAggregateFields,
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
const handleScopeLinks: TypedRouteHandler<"POST /admin/modifiers/:id/links"> = (
  request,
  { id },
) =>
  saveModifierLinks(
    request,
    id,
    writeScopeLinks,
    "Scope updated",
    scopeLinksChildGuard,
  );

/** POST handler that saves an answer-triggered modifier's answer links. */
const handleAnswerLinks: TypedRouteHandler<
  "POST /admin/modifiers/:id/answers"
> = (request, { id }) =>
  saveModifierLinks(
    request,
    id,
    (modifier, form) =>
      setModifierAnswers(modifier.id, selectedIds(form, "answer_ids")),
    "Answers updated",
  );

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
