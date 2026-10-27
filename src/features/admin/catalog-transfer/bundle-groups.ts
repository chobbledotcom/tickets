/**
 * The group-side bundle checks. They apply the single group import's member
 * rules to the stored rows the site holds and to the planned facts for the
 * document's own listings.
 */

import { packageMembersError } from "#db/groups.ts";
import { dayPriceFieldsFromInput } from "#shared/listing-edge.ts";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import { requireValue } from "#shared/required-value.ts";
import type { ListingWithCount } from "#types";
import { bundleListingOf } from "./bundle-listings.ts";
import type { FailureCollector } from "./bundle-names.ts";
import {
  bundlePackageMemberError,
  type ListingPlan,
  packageMemberRefusals,
} from "./bundle-plan.ts";
import { resolvedReference } from "./bundle-refs.ts";
import {
  type MembershipPairs,
  siteListingOf,
  specOfPair,
  type ValidationContext,
} from "./bundle-site.ts";
import { membersHomogeneous } from "./import-listing.ts";
import type { GroupBody } from "./schema.ts";

/** The member facts a bundle group's checks read: a stored row for a listing
 * the site already holds, the plan for one the document creates. */
type MemberFact =
  | { name: string; plan: ListingPlan; site: false }
  | { name: string; row: ListingWithCount; site: true };

/** The stored-or-planned facts behind one bundle group's member list. */
const memberFactsOf = (
  body: GroupBody,
  context: ValidationContext,
  listingPlans: readonly ListingPlan[],
): MemberFact[] => {
  const facts: MemberFact[] = [];
  for (const member of body.members) {
    // An unresolved member already failed the group item, so the checks never
    // reach this loop for it.
    const found = requireValue(
      resolvedReference(context.memberRefs.get(body)!, member.listing),
      "Referenced member missing",
    );
    if ("siteId" in found) {
      facts.push({
        name: member.listing,
        row: siteListingOf(found, context),
        site: true,
      });
    } else {
      facts.push({
        name: member.listing,
        plan: bundleListingOf(found, context, listingPlans),
        site: false,
      });
    }
  }
  return facts;
};

/** The group-homogeneity check over mixed members: stored rows and planned
 * listings carry the same two facts the rule reads. */
const homogeneityErrorOf = (facts: readonly MemberFact[]): string | null =>
  membersHomogeneous(
    facts.map((fact) =>
      fact.site
        ? {
            customisable_days: fact.row.customisable_days,
            listing_type: fact.row.listing_type,
            name: fact.name,
          }
        : {
            customisable_days: fact.plan.input.customisableDays ?? false,
            listing_type: fact.plan.input.listingType ?? "standard",
            name: fact.name,
          },
    ),
  );

/** Every package rule for one bundle group's members. The shared rule judges
 * the stored members in one batched edge load. Caps and day-price overrides
 * follow, member by member. */
const checkPackageMembers = async (
  body: GroupBody,
  memberFacts: readonly MemberFact[],
  pairs: MembershipPairs,
  item: string,
  fail: FailureCollector,
): Promise<void> => {
  const siteError = await packageMembersError(
    memberFacts
      .filter((fact) => fact.site)
      .map((fact) => ({
        can_pay_more: fact.row.can_pay_more,
        id: fact.row.id,
        name: fact.name,
      })),
    body.group.hidePackageListings,
  );
  fail.failIf(item, siteError);
  for (const fact of memberFacts) {
    if (!fact.site) {
      fail.failIf(
        item,
        bundlePackageMemberError(fact.plan, body.group.hidePackageListings),
      );
    }
    const spec = specOfPair(pairs, fact.name, item);
    const quantities = fact.site
      ? {
          max_quantity: fact.row.max_quantity,
          min_quantity: fact.row.min_quantity,
        }
      : {
          max_quantity: fact.plan.input.maxQuantity ?? 1,
          min_quantity: fact.plan.input.minQuantity ?? 1,
        };
    const dayFields = fact.site
      ? fact.row
      : dayPriceFieldsFromInput(fact.plan.input);
    for (const refusal of packageMemberRefusals(
      fact.name,
      quantities,
      spec,
      dayFields,
    )) {
      fail.failItem(item, refusal);
    }
  }
};

/** The group plans and their member rules, one group item at a time. */
export const validateGroups = async (
  context: ValidationContext,
  pairs: MembershipPairs,
  listingPlans: readonly ListingPlan[],
  fail: FailureCollector,
): Promise<{ body: GroupBody }[]> => {
  const plans: { body: GroupBody }[] = [];
  for (const body of context.bundle.groups) {
    const item = body.group.name;
    plans.push({ body });
    if (fail.hasFailed(item)) continue;
    const memberFacts = memberFactsOf(body, context, listingPlans);
    // A stored built-site plan books its own site and joins no group — the
    // same refusal a direct membership write raises.
    const planMember = memberFacts.find(
      (fact) => fact.site && fact.row.assign_built_site,
    );
    fail.failIf(
      item,
      planMember === undefined ? null : sitePlanMemberError(planMember.name),
    );
    fail.failIf(item, homogeneityErrorOf(memberFacts));
    if (body.group.isPackage ?? false) {
      await checkPackageMembers(body, memberFacts, pairs, item, fail);
    }
  }
  return plans;
};
