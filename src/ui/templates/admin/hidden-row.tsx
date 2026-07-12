/**
 * The "Hidden" detail-table row, shown on a listing or group that is kept out of
 * the public listings list. Shared by the listing details table and the group
 * details table so both word it the same way from one message-catalog key.
 */

import { t } from "#i18n";

export const HiddenDetailRow = (): JSX.Element => (
  <tr>
    <th>{t("listings_table.hidden")}</th>
    <td>{t("listings_table.yes_not_shown_in_public_list")}</td>
  </tr>
);
