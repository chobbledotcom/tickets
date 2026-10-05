import { t } from "#i18n";
import { LabelledRow } from "#templates/components/labelled-row.tsx";

/** The Guide answer that explains the two embed codes, at its own anchor. */
const EMBED_GUIDE_HREF = "/admin/guide#embed_booking_form";

/** A public page link with its three sharing actions under it. The link shows
 * the full URL, so a manual selection copies the whole address. The actions
 * are Share (the browser share sheet, or a copy), the QR code page, and the
 * embed guide. The actions sit below the link and wrap. A long URL never
 * pushes them off a narrow screen. The rows render on staff-only tabs, so
 * every viewer may open the guide the Embed action names. */
export const PublicTicketLink = ({
  href,
  qrHref,
}: {
  href: string;
  qrHref: string;
}): JSX.Element => (
  <span class="share-row">
    <a data-share-link href={href}>
      {href}
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
