import type { SiteDataBlob } from "#db/built-sites/blob.ts";
import type { PublicListing } from "#routes/api/public-listing.ts";
import { compareFindingIdentities } from "#scripts/unread-fields/identity.ts";
import {
  exemptFieldsAt,
  type FindingExemption,
} from "#scripts/unread-fields/policy.ts";
import type { SumupCheckoutRequest } from "#shared/sumup/transport.ts";
import type { WarningDeleteProps } from "#templates/admin/confirm-page.tsx";
import type { SettingsPageState } from "#templates/admin/settings.tsx";

const publicListings = exemptFieldsAt<PublicListing>(
  "src/features/api/public-listing.ts",
  [{ name: "PublicListing" }],
  {
    evidence: "apiResponse serialises the complete public listing",
    kind: "external-output",
  },
)({
  availableDates: "exempt",
  canPayMore: "exempt",
  children: "exempt",
  customisableDays: "exempt",
  date: "check",
  dayPrices: "exempt",
  description: "check",
  fields: "exempt",
  imageAltText: "exempt",
  imageUrl: "exempt",
  isClosed: "exempt",
  isSoldOut: "exempt",
  listingType: "exempt",
  location: "exempt",
  maxPrice: "exempt",
  maxPurchasable: "exempt",
  name: "check",
  nonTransferable: "exempt",
  purchaseOnly: "exempt",
  slug: "check",
  unitPrice: "exempt",
});

const sumupCheckoutRequests = exemptFieldsAt<SumupCheckoutRequest>(
  "src/shared/sumup/transport.ts",
  [{ name: "SumupCheckoutRequest" }],
  {
    evidence: "sumupInit serialises the complete checkout request",
    kind: "provider-input",
  },
)({
  amount: "exempt",
  checkout_reference: "exempt",
  currency: "exempt",
  description: "exempt",
  hosted_checkout: "exempt",
  merchant_code: "exempt",
  redirect_url: "exempt",
  return_url: "exempt",
});

const sumupHostedCheckout: FindingExemption = {
  identity: {
    exportedFrom: "src/shared/sumup/transport.ts",
    field: "enabled",
    path: [{ name: "SumupCheckoutRequest" }, { name: "hosted_checkout" }],
  },
  reason: {
    evidence: "sumupInit serialises the nested hosted checkout request",
    kind: "provider-input",
  },
};

const siteDataBlobs = exemptFieldsAt<SiteDataBlob>(
  "src/shared/db/built-sites/blob.ts",
  [{ name: "SiteDataBlob" }],
  {
    evidence: "SiteDataBlobSchema reads the stored versioned object",
    kind: "persisted-format",
  },
)({
  d: "exempt",
  dp: "exempt",
  hp: "exempt",
  n: "exempt",
  rt: "exempt",
  s: "exempt",
  sk: "exempt",
  t: "exempt",
  u: "exempt",
  v: "exempt",
});

const settingsPageStates = exemptFieldsAt<SettingsPageState>(
  "src/ui/templates/admin/settings.tsx",
  [{ name: "SettingsPageState" }],
  {
    evidence: "settingsForm reads state fields through each form definition",
    kind: "schema-driven",
  },
)({
  bookingFee: "exempt",
  businessEmail: "exempt",
  calendarFeedsEnabled: "exempt",
  calendarFeedsGroupBy: "exempt",
  currency: "check",
  embedHosts: "exempt",
  enabledFeatures: "check",
  headerImageUrl: "check",
  paymentProvider: "check",
  paymentProviderRecoveryChoices: "check",
  shownPaymentProvider: "check",
  squareWebhookConfigured: "check",
  storageEnabled: "check",
  superuser: "check",
  termsAndConditions: "exempt",
  theme: "check",
  underlineLinks: "exempt",
  webhookUrl: "check",
});

const warningDeleteProps = exemptFieldsAt<WarningDeleteProps>(
  "src/ui/templates/admin/confirm-page.tsx",
  [{ name: "WarningDeleteProps" }],
  {
    evidence: "warningDeletePage spreads the remaining props into ConfirmPage",
    kind: "dynamic-read",
  },
)({
  action: "exempt",
  buttonText: "exempt",
  heading: "check",
  label: "exempt",
  name: "exempt",
  prompt: "exempt",
  title: "check",
  warning: "exempt",
});

export const UNREAD_FIELD_EXEMPTIONS: readonly FindingExemption[] = [
  ...publicListings,
  ...settingsPageStates,
  ...siteDataBlobs,
  ...sumupCheckoutRequests,
  sumupHostedCheckout,
  ...warningDeleteProps,
].toSorted((left, right) =>
  compareFindingIdentities(left.identity, right.identity),
);
