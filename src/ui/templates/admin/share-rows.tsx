import { t } from "#i18n";
import { LabelledRow } from "#templates/components/labelled-row.tsx";

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
  <LabelledRow label={t("common.public_url")}>
    <em>{message}</em>
  </LabelledRow>
);
