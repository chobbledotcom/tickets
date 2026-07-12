import { t } from "#i18n";

/** Detail-table row explaining that an item is hidden from public listings. */
export const HiddenListingRow = (): JSX.Element => (
  <tr>
    <th>{t("listings_table.hidden")}</th>
    <td>{t("listings_table.yes_not_shown_in_public_list")}</td>
  </tr>
);
