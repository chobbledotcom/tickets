import { getSettingsNagItems } from "#shared/settings-nags.ts";
import type { NagItem } from "#shared/types.ts";

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
        <strong>Finish setting up your site:</strong>
      </p>
      <ul>
        {items.map((item) => (
          <li>
            <a href={item.href}>{item.label}</a>
          </li>
        ))}
      </ul>
    </output>
  );
};
