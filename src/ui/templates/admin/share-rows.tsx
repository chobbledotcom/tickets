import { t } from "#i18n";

export const PublicTicketLink = ({
  href,
  label,
  qrHref,
}: {
  href: string;
  label: string;
  qrHref: string;
}): JSX.Element => (
  <>
    <a href={href}>{label}</a>
    <small>
      {" "}
      (<a href={qrHref}>{t("common.qr_code")}</a>)
    </small>
  </>
);

export const UnavailablePublicUrlRow = ({
  message,
}: {
  message: string;
}): JSX.Element => (
  <tr>
    <th>{t("common.public_url")}</th>
    <td>
      <em>{message}</em>
    </td>
  </tr>
);
