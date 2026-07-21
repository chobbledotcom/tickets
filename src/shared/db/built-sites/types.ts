import * as v from "valibot";
import { guardFor } from "#shared/validation/guard.ts";

/** Release channels ordered from most to least eager. */
export const UPDATE_TIERS = ["alpha", "beta", "release"] as const;
export const UpdateTierSchema = v.picklist(UPDATE_TIERS);
export type UpdateTier = v.InferOutput<typeof UpdateTierSchema>;
export const DEFAULT_UPDATE_TIER: UpdateTier = "release";
export const isUpdateTier = guardFor(UpdateTierSchema);

export const siteAcceptsDeployTier = (
  siteTier: UpdateTier,
  deployTier: UpdateTier,
): boolean =>
  UPDATE_TIERS.indexOf(siteTier) <= UPDATE_TIERS.indexOf(deployTier);

export type HostingProvider = "bunny" | "deno";
export type DbProvider = "bunny" | "turso";

export const providerOrBunny = <
  TProvider extends Exclude<HostingProvider | DbProvider, "bunny">,
>(
  value: string | null | undefined,
  provider: TProvider,
): "bunny" | TProvider => (value === provider ? provider : "bunny");

export interface BuiltSiteRow {
  assignable: number;
  assigned_attendee_id: number | null;
  assigned_listing_id: number | null;
  created: string;
  id: number;
  read_only_from: string;
  renewal_token_index: string | null;
  site_data: string;
  site_data_revision: number;
  updates: UpdateTier;
}

export type BuiltSitePlainInput = {
  assignable?: number;
  assignedAttendeeId?: number | null;
  assignedListingId?: number | null;
  readOnlyFrom?: string;
  renewalTokenIndex?: string | null;
  updates?: UpdateTier;
};

export type BuiltSiteInput = BuiltSitePlainInput & { siteData: string };

export interface BuiltSite {
  assignable: boolean;
  assignedAttendeeId: number | null;
  assignedListingId: number | null;
  created: string;
  dbProvider: DbProvider;
  dbToken: string;
  dbUrl: string;
  hostingId: string;
  hostingProvider: HostingProvider;
  id: number;
  name: string;
  readOnlyFrom: string;
  renewalToken: string | null;
  renewalTokenIndex: string | null;
  scheduledTaskKey: string | null;
  siteDataRevision: number;
  siteUrl: string;
  updates: UpdateTier;
}

export type BuiltSiteFormInput = Pick<
  BuiltSite,
  "name" | "siteUrl" | "dbUrl" | "dbToken" | "hostingId" | "assignable"
> & {
  updates?: UpdateTier;
  hostingProvider?: HostingProvider;
  dbProvider?: DbProvider;
};

export type BuiltSitePlainFields = Pick<
  BuiltSite,
  | "assignable"
  | "assignedAttendeeId"
  | "assignedListingId"
  | "readOnlyFrom"
  | "renewalTokenIndex"
  | "siteDataRevision"
  | "updates"
>;

export type BuiltSiteBlobFields = Pick<
  BuiltSite,
  | "hostingId"
  | "siteUrl"
  | "dbToken"
  | "dbUrl"
  | "name"
  | "renewalToken"
  | "hostingProvider"
  | "dbProvider"
  | "scheduledTaskKey"
>;

export type BuiltSiteBlobInput = Omit<BuiltSiteBlobFields, "renewalToken"> & {
  renewalToken?: string | null | undefined;
};

export type BuiltSiteUpdate = Partial<BuiltSitePlainFields> &
  Partial<BuiltSiteBlobInput>;
