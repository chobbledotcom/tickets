import { t } from "#i18n";
import { CONTACT_JS_PATH } from "#shared/asset-paths.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { Flash } from "#shared/forms/flash.tsx";
import { MessageFields } from "#shared/forms/message-fields.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import {
  feedDiscoveryTags,
  MarkdownProse,
  type PublicNavProps,
  publicPage,
} from "./shared.tsx";

/** Public site page type */
export type PublicPageType = "home" | "terms" | "contact";

/**
 * Public site page - basic page with nav and content
 */
export const publicSitePage = (
  pageType: PublicPageType,
  nav: PublicNavProps,
  websiteTitle: string,
  content?: string | null,
): string => {
  const titles: Record<PublicPageType, string> = {
    contact: t("public.contact"),
    home: t("public.home"),
    terms: t("public.terms_and_conditions"),
  };
  const pageTitle = websiteTitle
    ? `${titles[pageType]} - ${websiteTitle}`
    : titles[pageType];

  return publicPage(
    pageTitle,
    websiteTitle,
    nav,
    pageType === "home",
  )(
    <div class="prose">
      {content ? (
        <Raw html={renderMarkdown(content)} />
      ) : (
        <p>
          <em>{t("public.no_content")}</em>
        </p>
      )}
    </div>,
  );
};

/** Message form shown on the public contact page. */
const ContactForm = ({
  botpoisonPublicKey,
}: {
  botpoisonPublicKey: string;
}): JSX.Element => {
  const botpoisonAttr: Record<`data-${string}`, string> = botpoisonPublicKey
    ? { "data-botpoison-public-key": botpoisonPublicKey }
    : {};
  return (
    <CsrfForm action="/contact" {...botpoisonAttr}>
      <h2>{t("public.send_us_a_message")}</h2>
      <label>
        {t("public.contact_email_label")}
        <input autocomplete="email" name="email" required type="email" />
      </label>
      <MessageFields />
    </CsrfForm>
  );
};

/**
 * Public contact page - optional descriptive text plus, when the contact form
 * is active, a message form. The Botpoison widget script is loaded only when a
 * public key is configured (progressive enhancement).
 */
export const contactPage = (options: {
  websiteTitle: string;
  content?: string | null;
  formActive: boolean;
  botpoisonPublicKey: string;
  nav: PublicNavProps;
  success?: string;
  error?: string;
}): string => {
  const { websiteTitle, content, formActive, botpoisonPublicKey } = options;
  const contactTitle = t("public.contact");
  const pageTitle = websiteTitle
    ? `${contactTitle} - ${websiteTitle}`
    : contactTitle;
  const loadWidget = formActive && botpoisonPublicKey !== "";
  const headExtra = loadWidget
    ? `${feedDiscoveryTags()}\n<script defer src="${CONTACT_JS_PATH}"></script>`
    : feedDiscoveryTags();

  return publicPage(
    pageTitle,
    websiteTitle,
    options.nav,
    false,
    headExtra,
  )(
    <>
      <Flash error={options.error} success={options.success} />
      <MarkdownProse markdown={content ?? ""} />
      {formActive && <ContactForm botpoisonPublicKey={botpoisonPublicKey} />}
    </>,
  );
};
