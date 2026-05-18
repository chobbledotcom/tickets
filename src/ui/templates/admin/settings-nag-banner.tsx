import { getSettingsNagItems } from "#shared/settings-nags.ts";

export const SettingsNagBanner = (): JSX.Element | null => {
  const items = getSettingsNagItems();
  if (items.length === 0) {
    return null;
  }
  return (
    <aside class="settings-nag-banner" role="status">
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
    </aside>
  );
};
