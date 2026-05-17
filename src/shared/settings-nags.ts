import { isBunnyCdnEnabled, isBunnyDnsEnabled } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";

/**
 * Unique identifiers for settings nags that prompt the admin to complete
 * required or recommended configuration.
 */
export type NagId = "payment-provider" | "business-email" | "domain";

/**
 * A single settings nag item presented to the admin.
 */
export type NagItem = {
  /** The nag identifier. */
  id: NagId;
  /** Human-readable description of what needs to be configured. */
  label: string;
  /** Deep link to the settings form where the value can be set. */
  href: string;
};

/**
 * Returns an ordered list of settings nags for incomplete configuration.
 * Items are returned in the order: payment-provider, business-email, domain.
 * An empty array means there are no pending nags.
 */
export const getSettingsNagItems = (): NagItem[] => {
  const items: NagItem[] = [];

  if (settings.paymentProviderSetting === null) {
    items.push({
      href: "/admin/settings#settings-payment-provider",
      id: "payment-provider",
      label:
        'Choose a payment provider on the settings page (saving "None" is fine).',
    });
  }

  if (settings.businessEmail === "") {
    items.push({
      href: "/admin/settings#settings-business-email",
      id: "business-email",
      label: "Set a business email so users have a contact address.",
    });
  }

  if (
    settings.customDomain === "" &&
    settings.bunnySubdomain === "" &&
    (isBunnyCdnEnabled() || isBunnyDnsEnabled())
  ) {
    items.push({
      href: "/admin/settings-advanced#settings-custom-domain",
      id: "domain",
      label:
        "Set either a custom domain or a host subdomain in advanced settings.",
    });
  }

  return items;
};
