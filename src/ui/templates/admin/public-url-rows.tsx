import { t } from "#i18n";
import { buildEmbedSnippets } from "#shared/embed.ts";
import { CopyableInputRow } from "#templates/admin/copyable-row.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";

/** The listing's or group's id. It names the hidden Embed toggle and the two
 * embed inputs, so one page's toggles never touch another's. */
type AvailablePublicUrl = {
  kind: "available";
  id: number;
  href: string;
  qrHref: string;
  scriptCode: string;
  iframeCode: string;
};

type UnavailablePublicUrl = {
  kind: "unavailable";
  message: string;
};

/** The Public URL section's content: the live rows, or the note that says why
 * the public page does not serve. */
export type PublicUrlRowsProps = AvailablePublicUrl | UnavailablePublicUrl;

/** The section's props for a public page that serves. The link, the QR
 * route, and the embed snippets derive from the entity's id, its slug, and
 * the domain. */
export const availablePublicUrl = (
  id: number,
  slug: string,
  allowedDomain: string,
): AvailablePublicUrl => {
  const href = `https://${allowedDomain}/ticket/${slug}`;
  const { iframe, script } = buildEmbedSnippets(href);
  return {
    href,
    id,
    iframeCode: iframe,
    kind: "available",
    qrHref: `/ticket/${slug}/qr`,
    scriptCode: script,
  };
};

const availableRows = ({
  href,
  id,
  iframeCode,
  qrHref,
  scriptCode,
}: AvailablePublicUrl): JSX.Element => (
  <>
    <LabelledRow label={t("common.public_url")}>
      <input
        class="visually-hidden embed-toggle"
        id={`embed-toggle-${id}`}
        type="checkbox"
      />
      <span class="public-url-row">
        <a data-share-link href={href}>
          {href}
        </a>
        <span class="public-url-actions">
          <button
            class="small-action"
            data-copied-label={t("common.copied")}
            data-share-url={href}
            type="button"
          >
            {t("common.share")}
          </button>
          <a class="small-action" href={qrHref}>
            {t("common.qr_code")}
          </a>
          <label class="small-action" for={`embed-toggle-${id}`}>
            {t("common.embed")}
          </label>
        </span>
      </span>
    </LabelledRow>
    <CopyableInputRow
      className="embed-code-row"
      id={`embed-script-${id}`}
      label={t("common.embed_script")}
      value={scriptCode}
    />
    <CopyableInputRow
      className="embed-code-row"
      id={`embed-iframe-${id}`}
      label={t("common.embed_iframe")}
      value={iframeCode}
    />
  </>
);

const unavailableRow = ({ message }: UnavailablePublicUrl): JSX.Element => (
  <LabelledRow label={t("common.public_url")}>
    <em>{message}</em>
  </LabelledRow>
);

/** The Public URL section both overview pages show. It holds the link row
 * with its three small actions, the hidden Embed toggle, and the two embed
 * code rows the toggle opens. The link shows the full URL, so a manual
 * selection copies the whole address. The actions sit below the link and
 * wrap, so a long URL never pushes them off a narrow screen. When the public
 * page does not serve, the section is the note that says why. The section
 * renders on staff-only tabs. */
export const PublicUrlRows = (props: PublicUrlRowsProps): JSX.Element =>
  props.kind === "available" ? availableRows(props) : unavailableRow(props);
