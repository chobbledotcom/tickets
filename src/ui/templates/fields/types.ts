/**
 * Typed form value interfaces.
 *
 * Each interface describes the shape returned by `validateForm<T>()` for a
 * specific set of field definitions. Required text fields produce `string`,
 * optional text fields produce `string` (empty string when absent), required
 * number fields produce `number`, and optional number fields produce
 * `number | null`.
 */

import type { AdminLevel, ListingFields, ListingType } from "#shared/types.ts";

/** Typed values from listing form validation */
export type ListingFormValues = {
  name: string;
  description: string;
  date: string;
  location: string;
  max_attendees: number;
  max_quantity: number;
  fields: ListingFields | "";
  unit_price: string;
  closes_at: string;
  thank_you_url: string;
  webhook_url: string;
  listing_type: ListingType | "";
  bookable_days: string;
  minimum_days_before: number | null;
  maximum_days_after: number | null;
  duration_days: number | null;
  customisable_days: string;
  non_transferable: string;
  group_id: string;
  can_pay_more: string;
  max_price: string;
  hidden: string;
  purchase_only: string;
  assign_built_site: string;
  months_per_unit: string;
  initial_site_months: string;
};

/** Typed values from listing edit form (includes slug) */
export type ListingEditFormValues = ListingFormValues & {
  slug: string;
};

/** Typed values from group create form validation (no slug - auto-generated) */
export type GroupCreateFormValues = {
  name: string;
  description: string;
  terms_and_conditions: string;
  max_attendees: number | null;
  hidden: string;
  is_package: string;
  hide_package_listings: string;
};

/** Typed values from group edit form validation (includes slug) */
export type GroupFormValues = GroupCreateFormValues & {
  slug: string;
};

/** Typed values from login form */
export type LoginFormValues = {
  username: string;
  password: string;
};

/** Typed values from setup form */
export type SetupFormValues = {
  admin_username: string;
  admin_password: string;
  admin_password_confirm: string;
};

/** Typed values from change password form */
export type ChangePasswordFormValues = {
  current_password: string;
  new_password: string;
  new_password_confirm: string;
};

/** Typed values from Stripe key form */
export type StripeKeyFormValues = {
  stripe_secret_key: string;
};

/** Typed values from Square access token form */
export type SquareTokenFormValues = {
  square_access_token: string;
  square_location_id: string;
};

/** Typed values from Square webhook form */
export type SquareWebhookFormValues = {
  square_webhook_signature_key: string;
};

/** Typed values from SumUp settings form */
export type SumupFormValues = {
  sumup_api_key: string;
  sumup_merchant_code: string;
};

/** Typed values from invite user form */
export type InviteUserFormValues = {
  username: string;
  admin_level: AdminLevel;
};
