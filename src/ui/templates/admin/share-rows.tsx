import { t } from "#i18n";
import { LabelledRow } from "#templates/components/labelled-row.tsx";

/** The Guide section that explains the two embed codes. */
export const EMBED_GUIDE_HREF = "/admin/guide#listings";

/** A public page link with its three sharing actions under it. The actions
 * are Share (the browser share sheet, or a copy), the QR code page, and the
 * embed guide. The actions sit below the link and wrap. A long URL never
 * pushes them off a narrow screen. */
export const PublicTicketLink = ({
  href,
  label,
  qrHref,
}: {
  href: string;
  label: string;
  qrHref: string;
}): JSX.Element => (
  <span class="share-row">
    <a data-share-link href={href}>
      {label}
    </a>
    <span class="share-actions">
      <button
        data-copied-label={t("common.copied")}
        data-share-url={href}
        type="button"
      >
        {t("common.share")}
      </button>
      <a class="btn" href={qrHref}>
        {t("common.qr_code")}
      </a>
      <a class="btn" href={EMBED_GUIDE_HREF}>
        {t("common.embed")}
      </a>
    </span>
  </span>
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
