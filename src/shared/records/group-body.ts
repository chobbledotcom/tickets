/** The group admin API write bodies. They sit beside the group fields, so
 *  the server's field read and the CLI's body check read one shape. The field
 *  views come from {@link GROUP_FIELDS}. A package member and the update slug
 *  are the two keys outside that list. */

import * as v from "valibot";
import {
  isValidMemberPrice,
  isValidMemberQuantity,
  memberDayPricesFault,
} from "#shared/groups/package-member-values.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { type ApiBody, apiBodyPair } from "#shared/rest/api-body-fields.ts";
import { apiFieldsOf } from "#shared/rest/field-values.ts";
import { positiveIntegerSchema } from "#shared/validation/number.ts";

const MEMBER_DAY_PRICES_MESSAGE =
  "package_members day_prices must be an object";
const MEMBER_DAYS_MESSAGE =
  "package_members day_prices keys must be positive day counts";
const MEMBER_PRICES_MESSAGE =
  "package_members day_prices values must be non-negative integers";

/** One member's per-day overrides: day-count keys and minor-unit values. The
 *  rule is the one the member parser reads, so both surfaces refuse the same
 *  map. */
const MemberDayPricesSchema = v.pipe(
  v.custom<Record<string, unknown>>(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
    MEMBER_DAY_PRICES_MESSAGE,
  ),
  v.record(
    v.string(),
    v.number(MEMBER_PRICES_MESSAGE),
    MEMBER_DAY_PRICES_MESSAGE,
  ),
  v.check(
    (value) => memberDayPricesFault(value) !== "days",
    MEMBER_DAYS_MESSAGE,
  ),
  v.check(
    (value) => memberDayPricesFault(value) === null,
    MEMBER_PRICES_MESSAGE,
  ),
);

/** `null` uses the listing price. `0` makes the member free. A positive whole
 *  minor-unit amount overrides it. */
const MemberPriceSchema = v.pipe(
  v.number("package_members price must be a non-negative integer or null"),
  v.check(
    (value: number) => isValidMemberPrice(value),
    "package_members price must be a non-negative integer or null",
  ),
);

/** The units one package grants of this member. A missing value is one. */
const MemberQuantitySchema = v.pipe(
  v.number("package_members quantity must be a positive integer"),
  v.check(
    (value: number) => isValidMemberQuantity(value),
    "package_members quantity must be a positive integer",
  ),
);

/** One package member's write body. The server lifts a missing price to null
 *  and a missing quantity to one, so both keys can be absent. */
const PackageMemberSchema = v.object(
  {
    day_prices: v.optional(MemberDayPricesSchema),
    listing_id: positiveIntegerSchema(
      "package_members listing_id must be a positive integer",
    ),
    price: v.optional(v.nullable(MemberPriceSchema)),
    quantity: v.optional(MemberQuantitySchema),
  },
  "package_members entries must be objects",
);

export type PackageMemberBody = v.InferOutput<typeof PackageMemberSchema>;

/** The optional member list. Absent leaves the stored overrides alone. An
 *  empty array clears them. The create body carries the key, as the old body
 *  type did. The group mapper still refuses it on create, because a group has
 *  no listings to give it yet. */
const packageMembersField = v.optional(
  v.array(PackageMemberSchema, "package_members must be an array"),
);

const groupBodies = apiBodyPair(apiFieldsOf(GROUP_FIELDS), {
  createOnly: { package_members: packageMembersField },
  updateOnly: {
    package_members: packageMembersField,
    slug: v.string("slug must be a string"),
  },
});

/** The body a group create accepts. */
export const CreateGroupBodySchema = groupBodies.create;

/** The body a group update accepts. */
export const UpdateGroupBodySchema = groupBodies.update;

export type CreateGroupBody = ApiBody<typeof CreateGroupBodySchema>;
export type UpdateGroupBody = ApiBody<typeof UpdateGroupBodySchema>;
