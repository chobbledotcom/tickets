import { isBunnyCdnEnabled, isBunnyDnsEnabled } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { getSuperuserState } from "#shared/superuser.ts";
import type { NagItem } from "#shared/types.ts";

/**
 * Returns an ordered list of settings nags for incomplete configuration.
 * Items are returned in the order: payment-provider, business-email, domain.
 * An empty array means there are no pending nags.
 */
export const getBaseSettingsNagItems = (): NagItem[] => {
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

export const getSettingsNagItems = (): NagItem[] => getBaseSettingsNagItems();

export const getSettingsNagItemsForOwner = async (): Promise<NagItem[]> => {
  const items = getBaseSettingsNagItems();
  const superuser = await getSuperuserState();
  if (superuser.available && superuser.choice === "" && !superuser.activated) {
    items.push({
      href: "/admin/settings#settings-superuser",
      id: "superuser",
      label: "Choose whether to enable a superuser recovery account.",
    });
  }
  return items;
};
