/**
 * Resolve which modifiers apply to a checkout, and rebuild them in the webhook.
 *
 * A modifier's stored `calc_value` is the positive magnitude the owner entered;
 * this layer turns it into the signed value the pricing engine expects (fixed
 * amounts converted from major to minor units, discounts negated, multipliers
 * left as the literal factor). The webhook re-fetches modifiers by id and
 * rebuilds the same specs, so provider metadata amounts are never trusted.
 */

import { unique } from "#fp";
import { t } from "#i18n";
import { itemsSubtotal } from "#shared/booking-fee.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { formatCurrency, toMinorUnits } from "#shared/currency.ts";
import {
  getVisits,
  hashEmail,
  hashPhone,
} from "#shared/db/contact-preferences.ts";
import { modifierUsedQuantities } from "#shared/db/modifier-usage.ts";
import {
  getActiveModifiers,
  getModifierGroupIdsByModifierId,
  getModifierGroupListingIdsByModifierId,
  getModifierListingIdsByModifierId,
  modifierIdsByAnswerId,
} from "#shared/db/modifiers.ts";
import type {
  CheckoutItem,
  ModifierRef,
  ModifierSpec,
} from "#shared/payments.ts";
import { type ModifierTrigger, normalizeCode } from "#shared/price-modifier.ts";
import type { ListingWithCount, Modifier } from "#shared/types.ts";

/** The signed pricing value the engine applies, from a modifier's stored
 * magnitude + direction. Multipliers ignore direction (the factor encodes it);
 * fixed amounts are entered in major currency units and stored as such. */
const signedValue = (modifier: Modifier): number => {
  if (modifier.calc_kind === "multiply") return modifier.calc_value;
  const magnitude =
    modifier.calc_kind === "fixed"
      ? toMinorUnits(modifier.calc_value)
      : modifier.calc_value;
  return modifier.direction === "discount" ? -magnitude : magnitude;
};

/** Resolve the listing ids each "groups"-scoped modifier covers. The default
 * resolves the group→listing membership live (the DB join); the would-be variant
 * (parents.md Fix 4) passes a resolver that expands against in-memory listings. */
type GroupScopeResolver = (
  groupScopedIds: number[],
) => Promise<Map<number, number[]>>;

const liveGroupScopeResolver: GroupScopeResolver =
  getModifierGroupListingIdsByModifierId;

/** Batched listing scopes for modifiers: null = whole order, array = scoped.
 * `resolveGroupScopes` chooses how a "groups"-scoped modifier's member listing
 * ids are resolved (live join by default; in-memory for the would-be check). */
const listingIdsByModifierId = async (
  modifiers: Modifier[],
  resolveGroupScopes: GroupScopeResolver = liveGroupScopeResolver,
): Promise<Map<number, number[] | null>> => {
  const scopes = new Map<number, number[] | null>();
  const listingScoped = modifiers.filter((m) => m.scope === "listings");
  const groupScoped = modifiers.filter((m) => m.scope === "groups");
  for (const modifier of modifiers) {
    if (modifier.scope === "all") scopes.set(modifier.id, null);
  }
  const [listingLinks, groupLinks] = await Promise.all([
    getModifierListingIdsByModifierId(listingScoped.map((m) => m.id)),
    resolveGroupScopes(groupScoped.map((m) => m.id)),
  ]);
  // Each lookup seeds an entry for every id it was given, so these maps cover
  // exactly the scoped modifiers — copy their links straight in.
  for (const [id, ids] of listingLinks) scopes.set(id, ids);
  for (const [id, ids] of groupLinks) scopes.set(id, ids);
  return scopes;
};

/** Build the checkout spec for a modifier applied `quantity` times. */
const toSpec = (
  modifier: Modifier,
  quantity: number,
  listingIds: number[] | null,
): ModifierSpec => ({
  id: modifier.id,
  kind: modifier.calc_kind,
  listingIds,
  name: modifier.name,
  quantity,
  trigger: modifier.trigger,
  value: signedValue(modifier),
});

/** Subtotal of the items a modifier is scoped to (the whole cart when its
 * listing ids are null), used for the minimum-subtotal and "alongside" checks. */
const inScopeSubtotal = (
  items: CheckoutItem[],
  listingIds: number[] | null,
): number =>
  itemsSubtotal(
    listingIds === null
      ? items
      : items.filter((i) => listingIds.includes(i.listingId)),
  );

/** A modifier eligible by scope and minimum subtotal, with the quantity the
 * buyer asked for (1 for automatic/code modifiers; the chosen count for an
 * opt-in add-on). Stock is clamped after candidates are gathered. */
type Candidate = {
  modifier: Modifier;
  listingIds: number[] | null;
  quantity: number;
};

/** How many units of a modifier can actually be applied, capping the requested
 * quantity at the remaining stock. Unlimited stock grants the full request. */
const stockedQuantity = (
  modifier: Modifier,
  requested: number,
  used: Map<number, number>,
): number => {
  if (modifier.stock === null) return requested;
  const remaining = modifier.stock - (used.get(modifier.id) ?? 0);
  return Math.max(0, Math.min(requested, remaining));
};

/** How many times a modifier is requested for a cart: automatic modifiers
 * apply once, a "code" modifier applies once when the entered code matches, an
 * opt-in add-on applies as many times as the buyer chose, and an "answer"
 * modifier applies once per selected answer linked to it (0 = none chosen).
 * A result below 1 means the modifier doesn't trigger at all. */
const triggerQuantity = (
  modifier: Modifier,
  codeIndex: string | null,
  addOns: Map<number, number>,
  answerQuantities: Map<number, number>,
): number => {
  if (modifier.trigger === "code") {
    return codeIndex !== null && modifier.code_index === codeIndex ? 1 : 0;
  }
  if (modifier.trigger === "optional") return addOns.get(modifier.id) ?? 0;
  if (modifier.trigger === "answer") {
    return answerQuantities.get(modifier.id) ?? 0;
  }
  return 1;
};

/** All active modifiers keyed by id, for the re-fetch-by-id lookups that
 * rebuild specs from refs and resolve answer-trigger scopes. */
const activeModifiersById = async (): Promise<Map<number, Modifier>> =>
  new Map((await getActiveModifiers()).map((m) => [m.id, m]));

/** Resolve the in-scope listing ids (null = whole order) of every active
 * answer-trigger modifier among `ids`. Ids that aren't an active answer
 * modifier are omitted, so a stale link never contributes a quantity. */
const answerModifierScopes = async (
  ids: number[],
): Promise<Map<number, number[] | null>> => {
  const byId = await activeModifiersById();
  return listingIdsByModifierId(
    ids
      .map((id) => byId.get(id))
      .filter(
        (modifier): modifier is Modifier => modifier?.trigger === "answer",
      ),
  );
};

/** Whether a resolved scope covers a listing: null = whole order (always),
 * an array = only its listings, undefined = not an eligible modifier (never). */
const scopeCoversListing = (
  scope: number[] | null | undefined,
  listingId: number,
): boolean =>
  scope === null || (Array.isArray(scope) && scope.includes(listingId));

/** Whether a resolved listing scope is reachable from a page's listing ids:
 * a whole-order scope (null) always is; a listing set must share an id. Shared
 * by the add-on listing and the child-reachability hard block. */
const scopeReachesPage = (
  scope: number[] | null,
  pageIds: Set<number>,
): boolean => scope === null || scope.some((id) => pageIds.has(id));

/**
 * The single reachability test shared by both child-scoped-add-on hard blocks
 * (the parent's edge save and a modifier's own scope/trigger save), so they can
 * never diverge. An opt-in add-on is a dead end exactly when its resolved scope
 * is a **listing set** (a whole-order scope, `null`, is reachable everywhere)
 * that **names at least one suppressed child** yet **does not reach any of the
 * pages that would actually load it** — so no direct `/ticket/<listing>` page
 * (which loads add-ons from only that listing's own id) and no group page can
 * ever offer it.
 *
 * Callers supply the two id sets that define "reachable" from their own side:
 * - the **edge save** treats the new child as the only `suppressed` id and the
 *   parent's own page id as the only `reachable` one;
 * - the **modifier save** treats every existing child as `suppressed` and every
 *   active non-child listing as `reachable` (each has its own bookable page; an
 *   inactive listing serves no public page, so it can't rescue the add-on).
 */
const scopeIsChildDeadEnd = (
  scope: number[] | null,
  suppressed: Set<number>,
  reachable: Set<number>,
): boolean => {
  if (scope === null) return false;
  return (
    scope.some((id) => suppressed.has(id)) &&
    !scopeReachesPage(scope, reachable)
  );
};

/**
 * Total quantity each "answer"-triggered modifier is requested for, respecting
 * the modifier's own scope. A linked answer counts only when it was selected on
 * a listing the modifier applies to (every booked listing, for a whole-order
 * modifier), so a listing/group-scoped answer modifier is never inflated by the
 * same shared answer being picked on a listing outside its scope. Each in-scope
 * selection adds that listing's ticket quantity, so one "Large size +£5"
 * modifier wired to several answers is applied once per matching ticket.
 */
export const answerModifierQuantities = async (
  listingAnswerIds: Record<string, number[]> | undefined,
  listingQuantities: Map<number, number>,
): Promise<Map<number, number>> => {
  const entries = Object.entries(listingAnswerIds ?? {});
  const answerIds = unique(entries.flatMap(([, ids]) => ids));
  const modifiersByAnswer = await modifierIdsByAnswerId(answerIds);
  if (modifiersByAnswer.size === 0) return new Map();
  const scopes = await answerModifierScopes(
    unique([...modifiersByAnswer.values()].flat()),
  );

  const quantities = new Map<number, number>();
  for (const [listingIdStr, ids] of entries) {
    const listingId = Number(listingIdStr);
    // Every key here is a selected listing, so it always has a chosen quantity.
    const count = listingQuantities.get(listingId)!;
    const modifierIds = ids.flatMap((id) => modifiersByAnswer.get(id) ?? []);
    for (const modifierId of modifierIds) {
      if (scopeCoversListing(scopes.get(modifierId), listingId)) {
        quantities.set(modifierId, (quantities.get(modifierId) ?? 0) + count);
      }
    }
  }
  return quantities;
};

export type PricingContext = { visits: number };

const NO_VISITS: PricingContext = { visits: 0 };

export const buyerVisits = async (
  email?: string,
  phone?: string,
): Promise<number> => {
  const usable = (value: string | undefined): value is string =>
    typeof value === "string" && value.trim() !== "";
  const hashes = await Promise.all(
    [
      usable(email) ? hashEmail(email) : null,
      usable(phone) ? hashPhone(phone) : null,
    ].filter((hash): hash is Promise<string> => hash !== null),
  );
  if (hashes.length === 0) return 0;
  const counts = await Promise.all(hashes.map(getVisits));
  return Math.max(0, ...counts);
};

export type ResolveOptions = {
  code?: string;
  addOns?: Map<number, number>;
  answerQuantities?: Map<number, number>;
  ctx?: PricingContext;
};

/**
 * Active modifiers eligible for a cart, each with the quantity the buyer asked
 * for, *before* any stock clamp: past the visit gate, actually triggered
 * (quantity >= 1), in scope, and past the minimum subtotal. Automatic modifiers
 * always trigger; a "code" modifier triggers only on a matching code; an
 * "optional" add-on triggers per chosen unit (`opts.addOns`); an "answer"
 * modifier triggers per linked answer selected (`opts.answerQuantities`).
 *
 * `resolveModifiers` clamps these to the stock remaining; the sold-out check
 * reads the requested quantity straight off them, so both share one eligibility
 * pass and agree on which modifiers apply.
 */
const eligibleCandidates = async (
  items: CheckoutItem[],
  opts: ResolveOptions,
): Promise<Candidate[]> => {
  const addOns = opts.addOns ?? new Map<number, number>();
  const answerQuantities = opts.answerQuantities ?? new Map<number, number>();
  const ctx = opts.ctx ?? NO_VISITS;
  const codeIndex = opts.code?.trim()
    ? await hmacHash(normalizeCode(opts.code))
    : null;
  const activeModifiers = await getActiveModifiers();
  const scopes = await listingIdsByModifierId(activeModifiers);
  return (
    await Promise.all(
      activeModifiers.map(async (modifier): Promise<Candidate | null> => {
        if (modifier.min_visits > ctx.visits) return null;
        const quantity = triggerQuantity(
          modifier,
          codeIndex,
          addOns,
          answerQuantities,
        );
        if (quantity < 1) return null;
        const listingIds = scopes.get(modifier.id)!;
        const base = inScopeSubtotal(items, listingIds);
        // A scoped modifier only applies alongside its listings/groups.
        if (listingIds !== null && base === 0) return null;
        return base >= modifier.min_subtotal
          ? { listingIds, modifier, quantity }
          : null;
      }),
    )
  ).filter((c): c is Candidate => c !== null);
};

/**
 * The modifiers that apply to a cart: {@link eligibleCandidates} with their
 * quantities clamped to the stock remaining (a candidate clamped to zero drops
 * out). Each surviving modifier is applied its (possibly clamped) number of
 * times.
 */
export const resolveModifiers = async (
  items: CheckoutItem[],
  opts: ResolveOptions = {},
): Promise<ModifierSpec[]> => {
  const candidates = await eligibleCandidates(items, opts);
  // One batched usage lookup for every stock-limited candidate.
  const used = await modifierUsedQuantities(
    candidates
      .filter((c) => c.modifier.stock !== null)
      .map((c) => c.modifier.id),
  );
  return candidates
    .map((c) => ({
      candidate: c,
      quantity: stockedQuantity(c.modifier, c.quantity, used),
    }))
    .filter(({ quantity }) => quantity >= 1)
    .map(({ candidate, quantity }) =>
      toSpec(candidate.modifier, quantity, candidate.listingIds),
    );
};

/**
 * Names of answer-triggered modifiers the buyer over-subscribed: tiers that
 * would actually apply to this cart — the same eligibility `resolveModifiers`
 * uses (scope, minimum subtotal, visit gate) — and are stock-limited, but whose
 * requested quantity exceeds the stock remaining. Because an answer is recorded
 * on every ticket that picked it (it can't be partially fulfilled like an
 * opt-in add-on), the submission is blocked rather than silently clamped.
 *
 * Gating on eligibility, not stock alone, means a tier the cart is too small
 * for — or that the buyer lacks the visits for — isn't reported sold out when
 * no surcharge would apply.
 */
export const oversubscribedAnswerTiers = async (
  items: CheckoutItem[],
  opts: ResolveOptions = {},
): Promise<string[]> => {
  const limited = (await eligibleCandidates(items, opts)).filter(
    (c) => c.modifier.trigger === "answer" && c.modifier.stock !== null,
  );
  if (limited.length === 0) return [];
  const used = await modifierUsedQuantities(limited.map((c) => c.modifier.id));
  return limited
    .filter(
      // stock is non-null here (filtered just above).
      (c) =>
        c.quantity >
        Math.max(0, c.modifier.stock! - (used.get(c.modifier.id) ?? 0)),
    )
    .map((c) => c.modifier.name);
};

/** Whether any active modifier is unlocked by a promo code, so the public
 * order form knows to offer a code field. */
export const hasPromoCodeModifiers = async (): Promise<boolean> =>
  (await getActiveModifiers()).some((m) => m.trigger === "code");

/** Display details for an opt-in add-on offered on the public order form. */
export type AddOnOption = {
  id: number;
  name: string;
  /** Buyer-facing price effect, e.g. "+£5", "−10%", "×1.5". */
  priceLabel: string;
  /** True when selecting this add-on can route an otherwise-free cart to payment. */
  requiresPayment: boolean;
  /** The most units a buyer may select, capped by remaining stock. */
  maxQuantity: number;
};

/** Default ceiling on the add-on quantity selector when stock is unlimited. */
export const ADDON_MAX_QUANTITY = 20;

/** The buyer-facing price label for an add-on: a signed amount or percentage,
 * or a bare multiplier (whose factor already encodes its direction). */
const addOnPriceLabel = (modifier: Modifier): string => {
  if (modifier.calc_kind === "multiply") return `×${modifier.calc_value}`;
  const sign = modifier.direction === "discount" ? "−" : "+";
  const amount =
    modifier.calc_kind === "fixed"
      ? formatCurrency(toMinorUnits(modifier.calc_value))
      : `${modifier.calc_value}%`;
  return `${sign}${amount}`;
};

const addOnCanRequirePayment = (modifier: Modifier): boolean =>
  modifier.calc_kind === "fixed" && signedValue(modifier) > 0;

/** Active opt-in ("optional") add-on modifiers paired with their resolved
 * listing scopes (null = whole order), the shared starting point for the add-on
 * listing and the child-reachability hard block. `resolveGroupScopes` chooses how
 * group scopes resolve (live join by default; in-memory for the would-be Fix 4
 * check). */
const optionalAddOnsWithScopes = async (
  resolveGroupScopes?: GroupScopeResolver,
): Promise<{
  optional: Modifier[];
  scopes: Map<number, number[] | null>;
}> => {
  const optional = (await getActiveModifiers()).filter(
    (m) => m.trigger === "optional",
  );
  return {
    optional,
    scopes: await listingIdsByModifierId(optional, resolveGroupScopes),
  };
};

/**
 * The opt-in add-ons offered for a page's listings: active "optional"
 * modifiers whose scope covers the whole order or overlaps the page, with
 * stock left. Each carries the quantity ceiling the selector should allow.
 */
export const getOptionalAddOns = async (
  pageListingIds: number[],
): Promise<AddOnOption[]> => {
  const { optional, scopes } = await optionalAddOnsWithScopes();
  const pageIds = new Set(pageListingIds);
  const scoped = optional.filter((modifier) =>
    scopeReachesPage(scopes.get(modifier.id)!, pageIds),
  );
  const used = await modifierUsedQuantities(
    scoped.filter((m) => m.stock !== null).map((m) => m.id),
  );
  return scoped
    .map((modifier) => ({
      maxQuantity: stockedQuantity(modifier, ADDON_MAX_QUANTITY, used),
      modifier,
    }))
    .filter(({ maxQuantity }) => maxQuantity >= 1)
    .map(({ maxQuantity, modifier }) => ({
      id: modifier.id,
      maxQuantity,
      name: modifier.name,
      priceLabel: addOnPriceLabel(modifier),
      requiresPayment: addOnCanRequirePayment(modifier),
    }));
};

/**
 * The name of an active opt-in add-on that would become **unreachable** if
 * `childId` were made a child of a parent whose own booking page loads add-ons
 * from `parentPageListingIds`, or null when none would.
 *
 * A direct `/ticket/<parent>` page loads add-ons from **only the parent's own
 * listing id** (`getTicketContext` → `getOptionalAddOns([parent.id])`), never
 * its group siblings — a sibling-scoped modifier loads only on that sibling's
 * own page/group page. So `parentPageListingIds` is the parent's *actual* page
 * id set (`[parent.id]`), not the wider group: an add-on scoped to
 * {child, parent-sibling} but not the parent is a dead end the direct parent
 * page can't reach, and must block.
 *
 * v1 doesn't support child-scoped add-ons: a child is never one of a parent
 * page's listing ids, so `getOptionalAddOns(pageListingIds)` never loads an
 * add-on whose entire reachable scope is suppressed children. The test is
 * **reachability**, not "the child appears in the scope": an add-on scoped to
 * the child *and also* to the parent (or to a group containing the parent) still
 * loads via the parent's page ids and must NOT block the edge. (See parents.md,
 * the "Optional add-ons" fold-checklist bullet.)
 */
export const childOnlyAddOnName = async (
  childId: number,
  parentPageListingIds: readonly number[],
): Promise<string | null> =>
  childOnlyAddOnNameWithScopes(
    await optionalAddOnsWithScopes(),
    childId,
    parentPageListingIds,
  );

/** The reachability loop shared by the live-scope {@link childOnlyAddOnName} and
 * the would-be-scope {@link childOnlyAddOnNameForListings} (a listing save that
 * changes `group_id`): the name of the first active opt-in add-on whose resolved
 * scope dead-ends through `childId` for a parent page of `parentPageListingIds`,
 * or null. */
const childOnlyAddOnNameWithScopes = (
  {
    optional,
    scopes,
  }: { optional: Modifier[]; scopes: Map<number, number[] | null> },
  childId: number,
  parentPageListingIds: readonly number[],
): string | null => {
  const suppressed = new Set([childId]);
  const reachable = new Set(parentPageListingIds);
  const blocking = optional.find((modifier) =>
    scopeIsChildDeadEnd(scopes.get(modifier.id)!, suppressed, reachable),
  );
  return blocking?.name ?? null;
};

/** A listing plus the ids of the groups it belongs to — the in-memory shape the
 * would-be-scope reachability checks reason over. Built from `getAllListings`
 * plus a `group_listings` membership map, with the saved listing's would-be
 * group set applied. `active` is only consulted by the deactivation check. */
export type ListingGroupMembership = {
  id: number;
  groupIds: number[];
  active?: boolean;
};

/** The ids of the supplied listings that belong to ANY of `groupIds` — the
 * in-memory expansion of a "groups"-scoped modifier (or any group → its member
 * listings resolution). A listing in several groups matches if any of them is in
 * scope. Shared so the live and would-be scope resolutions agree. */
export const listingIdsInGroups = (
  groupIds: number[],
  allListings: ListingGroupMembership[],
): number[] => {
  const groups = new Set(groupIds);
  return allListings
    .filter((listing) => listing.groupIds.some((g) => groups.has(g)))
    .map((listing) => listing.id);
};

/**
 * A {@link GroupScopeResolver} that expands each group-scoped modifier against
 * an **in-memory** listing set, so a caller can test reachability under a
 * listing's *would-be* `group_id` (which the live `modifier_groups`→`listings`
 * join wouldn't yet reflect — parents.md Fix 4). Fetches each modifier's linked
 * group ids, then maps them to the supplied listings' ids via
 * {@link listingIdsInGroups}.
 */
const inMemoryGroupScopeResolver =
  (allListings: ListingGroupMembership[]): GroupScopeResolver =>
  async (groupScopedIds) => {
    const groupLinks = await getModifierGroupIdsByModifierId(groupScopedIds);
    return new Map(
      [...groupLinks].map(([id, groupIds]) => [
        id,
        listingIdsInGroups(groupIds, allListings),
      ]),
    );
  };

/**
 * Like {@link childOnlyAddOnName}, but resolving add-on scopes against the
 * supplied **in-memory** listings (with the saved listing's would-be `group_id`
 * already applied), so a listing save that moves a parent out of the group a
 * child-only add-on is scoped to is caught before it orphans the add-on
 * (parents.md Fix 4).
 */
export const childOnlyAddOnNameForListings = async (
  childId: number,
  parentPageListingIds: readonly number[],
  allListings: ListingGroupMembership[],
): Promise<string | null> =>
  childOnlyAddOnNameWithScopes(
    await optionalAddOnsWithScopes(inMemoryGroupScopeResolver(allListings)),
    childId,
    parentPageListingIds,
  );

/** The post-save shape of an opt-in add-on whose child-reachability must hold:
 * its trigger/active state and its **already-resolved** listing scope (null =
 * whole order; for a group scope, every listing in the linked groups). */
export type AddOnReachabilityCheck = {
  active: boolean;
  trigger: ModifierTrigger;
  name: string;
  scope: number[] | null;
};

/**
 * The error to show when saving an opt-in add-on (created, or its
 * scope/trigger/active edited) would leave it reachable **only** through a
 * suppressed child listing — the modifier-side mirror of {@link childOnlyAddOnName},
 * sharing one reachability core ({@link scopeIsChildDeadEnd}) so the edge-save
 * and modifier-save blocks can't drift, or null when the save is allowed.
 *
 * Only an **active, opt-in** add-on is gated: an inactive or non-`optional`
 * modifier never loads on a booking page, so it can't dead-end. The resolved
 * scope is treated as reachable from each listing in `reachablePageIds` — the
 * **active, non-child** listings, since only those serve a public booking page
 * that loads add-ons — and a dead end only when it names a child but reaches
 * none of those pages.
 */
export const childUnreachableAddOnError = (
  candidate: AddOnReachabilityCheck,
  childListingIds: Set<number>,
  reachablePageIds: Set<number>,
): string | null => {
  if (!candidate.active || candidate.trigger !== "optional") return null;
  return scopeIsChildDeadEnd(candidate.scope, childListingIds, reachablePageIds)
    ? t("modifiers.err_child_only_addon", { name: candidate.name })
    : null;
};

/**
 * The name of the first **active opt-in add-on** that would be left a dead end
 * (reachable only through a suppressed child) given an **in-memory** listing set,
 * or null when every add-on still has a live page that can offer it. Used by a
 * listing save that flips `active` to re-check reachability for the *whole* set
 * of add-ons — not just edges touching the saved listing (parents.md Fix 5): a
 * plain non-child page that is the only thing rescuing a child-scoped add-on has
 * no edge of its own, so the edge-touching traversal would miss it.
 *
 * `allListings` carries the save's would-be state (the deactivated listing
 * marked inactive). `childListingIds` are the suppressed children; the reachable
 * pages are the **active, non-child** listings in `allListings` (only those
 * serve a public booking page that loads add-ons), so deactivating the sole such
 * page drops it from the reachable set and surfaces the dead end. Group scopes
 * resolve against `allListings` so a group-scoped add-on reflects the same set.
 */
export const firstChildUnreachableAddOnForListings = async (
  allListings: ListingGroupMembership[],
  childListingIds: Set<number>,
): Promise<string | null> => {
  const { optional, scopes } = await optionalAddOnsWithScopes(
    inMemoryGroupScopeResolver(allListings),
  );
  const reachablePageIds = new Set(
    allListings
      .filter((listing) => listing.active && !childListingIds.has(listing.id))
      .map((listing) => listing.id),
  );
  for (const modifier of optional) {
    const error = childUnreachableAddOnError(
      {
        active: modifier.active,
        name: modifier.name,
        scope: scopes.get(modifier.id)!,
        trigger: modifier.trigger,
      },
      childListingIds,
      reachablePageIds,
    );
    if (error) return error;
  }
  return null;
};

/**
 * Rebuild modifier specs from the references stored in session metadata,
 * re-fetching each modifier's current values (and scope) from the database.
 * References to modifiers that have since been removed or deactivated are
 * dropped (the webhook then sees a total mismatch and refunds).
 */
export const specsFromRefs = async (
  refs: ModifierRef[],
  ctx: PricingContext = NO_VISITS,
): Promise<ModifierSpec[]> => {
  if (refs.length === 0) return [];
  const byId = await activeModifiersById();
  const refModifiers = refs
    .map((ref) => byId.get(ref.i))
    .filter((modifier): modifier is Modifier => modifier !== undefined);
  const scopes = await listingIdsByModifierId(refModifiers);
  const specs = refs.map((ref) => {
    const modifier = byId.get(ref.i);
    if (modifier && modifier.min_visits > ctx.visits) return null;
    return modifier ? toSpec(modifier, ref.q, scopes.get(modifier.id)!) : null;
  });
  return specs.filter((s): s is ModifierSpec => s !== null);
};
