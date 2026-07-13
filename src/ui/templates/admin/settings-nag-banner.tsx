import { t } from "#i18n";
import { getSettingsNagItems } from "#shared/settings-nags.ts";
import type { NagItem } from "#shared/types.ts";
import { ItemList } from "#templates/components/item-list.tsx";

export const SettingsNagBanner = ({
  items = getSettingsNagItems(),
}: {
  items?: readonly NagItem[];
} = {}): JSX.Element | null => {
  if (items.length === 0) {
    return null;
  }
  return (
    <output class="settings-nag-banner">
      <p>
        <strong>{t("settings.nag_banner_heading")}</strong>
      </p>
      <ItemList
        items={items}
        render={(item) => <a href={item.href}>{item.label}</a>}
      />
    </output>
  );
};
