import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin price-modifier management routes — accessible to owners and managers.
 */

/* jscpd:ignore-start */
import { once } from "#fp";
import { t } from "#i18n";
import {
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  runRecalculatePost,
} from "#routes/admin/aggregate-recalculation.ts";
import { loadAccountLedger } from "#routes/admin/ledger/statements.ts";
import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import { AUTH_FORM, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { modifierAccount } from "#shared/accounting/accounts.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getGroupIdsByListingIds, groups } from "#shared/db/groups.ts";
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
import { exceedsCurrencyPrecision } from "#shared/validation/money.ts";
import { adminModifierRecalculatePage } from "#templates/admin/modifiers/aggregates.tsx";
import type {
  AnswerLinks,
  ScopeLinks,
} from "#templates/admin/modifiers/links.tsx";
import {
  adminModifierDeletePage,
  adminModifierEditPage,
  adminModifierNewPage,
  adminModifiersPage,
} from "#templates/admin/modifiers/pages.tsx";
import { modifierAggregateFields } from "#templates/fields/aggregate.ts";
import {
  getModifierFields,
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
  values: ModifierAggregateValues,
): ModifierAggregateValues => ({
  total_uses: values.total_uses,
  usage_count: values.usage_count,
});

/** Resolve an opt-in add-on's would-be listing scope to ids the booking page
 * would actually load it from: `"listings"` keeps its directly-linked ids,
 * `"groups"` expands to every listing in the linked groups (matching the booking
 * page's resolution), and a whole-order scope is `null` (reachable everywhere). */
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

/** The post-save trigger/active/scope of an opt-in add-on, with its would-be
 * links (submitted ids on a scope save, stored ids on a field edit/create). A
 * missing `scope` is whole-order, like the stored default. */
type AddOnSaveCandidate = {
  active: boolean;
  trigger: ModifierTrigger;
  name: string;
  scope: ModifierScope | undefined;
  listingIds: number[];
  groupIds: number[];
};

/**
 * The error to block an opt-in add-on save (scope/trigger/active edit or scope
 * links) that would leave the add-on reachable **only** through a suppressed
 * child listing, or null when allowed. Resolves the would-be scope to listing
 * ids, then defers to the shared reachability core
 * ({@link childUnreachableAddOnError}) so this modifier-side block and the
 * parent-edge block can't diverge.
 */
const childAddOnSaveError = async (
  candidate: AddOnSaveCandidate,
): Promise<string | null> => {
  const allListings = await getAllListings();
  const allIds = allListings.map((listing) => listing.id);
  const [childIds, membership] = await Promise.all([
    getNonStandaloneChildIds(allIds),
    getGroupIdsByListingIds(allIds),
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

/** The child-reachability error for a create/edit through the modifier resource:
 * its trigger/active/scope come from the submitted input, while its links are the
 * stored ones (a field edit never touches them; a create has none yet). Skipped
 * unless the input is a complete opt-in add-on. */
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

/** The value error for a modifier: the kind-aware magnitude/sign rules
 * ({@link validateCalcValue}), plus a currency-precision guard for a fixed
 * amount — it's a currency value (converted major→minor when the modifier
 * resolves), so an over-precise amount is rejected rather than letting
 * `toMinorUnits` silently round it at apply time. A percentage or multiplier is
 * not a currency amount, so it keeps its precision. Null when the value is
 * valid. */
const modifierValueError = (kind: CalcKind, value: number): string | null => {
  const valueError = validateCalcValue(kind, value);
  if (valueError) return valueError;
  return kind === "fixed" && exceedsCurrencyPrecision(value)
    ? "Amount has more decimal places than your currency allows"
    : null;
};

/** Validate a modifier's kind, direction, trigger, scope, and value (the select
 * options can be bypassed by a crafted POST, so re-check membership here), then
 * — when the parents feature is on — block an opt-in add-on whose would-be scope
 * is reachable only through a suppressed child listing. */
const validateModifier = (
  input: ModifierInput,
  id?: number,
): Promise<string | null> => {
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
  return childAddOnInputError(input, id);
};

/** The kind-aware `calc_value` check, run on the raw form values (where the
 * chosen `calc_kind` sits beside the value) before they are converted to a
 * {@link ModifierInput}. A crafted POST can still send an unknown kind, so the
 * bounds are skipped for one — {@link validateModifier} rejects it by name. */
const modifierValuesError = (values: ModifierFormValues): string | null =>
  isCalcKind(values.calc_kind)
    ? modifierValueError(values.calc_kind, values.calc_value)
    : null;

// Built lazily on first use (never at module load), so `getModifierFields()` —
// whose picklist option labels resolve through `t()` — stays off the admin
// routes' cold-start path. `once` caches the resource after the first build.
const getModifiersResource = once(() =>
  defineNamedResource<ModifierRow, ModifierInput, number, ModifierFormValues>({
    fields: getModifierFields(),
    nameField: "name",
    table: modifiersTable,
    toInput: extractModifierInput,
    validate: validateModifier,
    validateValues: modifierValuesError,
  }),
);

// The list renders the projected total_revenue (Display = Modifier from
// getAllModifiers), while the resource and the delete page load the stored row
// (Row = ModifierRow). The edit GET/POST are served by the projection-aware
// handleEditGet/handleEditPost below, so this CRUD config omits renderEdit.
const crud = createCrudHandlers({
  getAll: getAllModifiers,
  getName: (m: ModifierRow) => m.name,
  listPath: "/admin/modifiers",
  renderDelete: adminModifierDeletePage,
  renderList: adminModifiersPage,
  renderNew: adminModifierNewPage,
  resource: getModifiersResource,
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

/** The candidate answers + current links for an "answer"-triggered modifier's
 * editor, or null otherwise. Options are flattened across every question so the
 * owner can wire several answers (across questions) to one pricing modifier. */
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

const withModifier = withEntityLoader(getModifier);

const loadModifierLedgerForSession = (
  session: { adminLevel: string },
  modifier: Modifier,
) => {
  if (session.adminLevel !== "owner") return Promise.resolve(undefined);
  return loadAccountLedger(modifierAccount(modifier.id));
};

/** Edit page with the scope link editor (listing/group-scoped modifiers) and
 * the answer link editor (answer-triggered modifiers). */
const handleEditGet: TypedRouteHandler<"GET /admin/modifiers/:id/edit"> = (
  request,
  { id },
) =>
  requireSessionOr(request, (session) =>
    withModifier(id)(async (modifier) => {
      const flash = applyFlash(request);
      const [links, answerLinks, ledger] = await Promise.all([
        scopeLinksFor(modifier),
        answerLinksFor(modifier),
        loadModifierLedgerForSession(session, modifier),
      ]);
      return htmlResponse(
        adminModifierEditPage(
          modifier,
          session,
          flash.error,
          links,
          flash.success,
          answerLinks,
          ledger,
        ),
      );
    }),
  );

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
    >(form, modifierAggregateFields, extractModifierAggregateValues);
    if (!aggregates.ok) {
      return errorRedirect(`/admin/modifiers/${id}/edit`, aggregates.error);
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
    return errorRedirect(`/admin/modifiers/${id}/edit`, result.error);
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

const handleModifierRecalculateGet: TypedRouteHandler<
  "GET /admin/modifiers/recalculate/:modifierId"
> = (request, { modifierId }) =>
  requireSessionOr(request, (session) =>
    withModifier(modifierId)((modifier) => {
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
    withModifier(modifierId)((modifier) =>
      runRecalculatePost({
        fields: MODIFIER_AGGREGATE_FIELDS,
        form,
        log: () =>
          logActivity(`Modifier '${modifier.name}' totals recalculated`),
        renderChoose: () =>
          renderModifierRecalculatePage(
            modifier,
            session,
            t("modifiers.recalculate.choose"),
          ),
        reset: (selected) =>
          resetModifierAggregateFields(modifier.id, selected),
        successMessage: t("modifiers.recalculate.success"),
        successPath: `/admin/modifiers/${modifier.id}/edit`,
      }),
    ),
  );

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

/** Modifier routes */
export const adminHandlers = handlersFor("modifiers")({
  getModifiers: crud.listGet,
  getModifiersByIdDelete: crud.deleteGet,

  getModifiersByIdEdit: handleEditGet,
  getModifiersNew: crud.newGet,
  getModifiersRecalculateByModifierId: handleModifierRecalculateGet,
  postModifiers: crud.createPost,
  postModifiersByIdAnswers: handleAnswerLinks,
  postModifiersByIdDelete: crud.deletePost,
  postModifiersByIdEdit: handleEditPost,
  postModifiersByIdLinks: handleScopeLinks,
  postModifiersByIdRevenue: handleRevenueAdjust,
  postModifiersRecalculateByModifierId: handleModifierRecalculatePost,
});
