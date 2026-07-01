import { t } from "#i18n";
import { CONTACT_JS_PATH } from "#shared/asset-paths.ts";
import { CsrfForm, Flash, MessageFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { Layout } from "#templates/layout.tsx";
import {
  FEED_DISCOVERY_TAGS,
  PublicNav,
  type PublicNavProps,
} from "./shared.tsx";

/** Public site page type */
export type PublicPageType = "home" | "terms" | "contact";

/**
 * Public site page - basic page with nav and content
 */
export const publicSitePage = (
  pageType: PublicPageType,
  nav: PublicNavProps,
  websiteTitle?: string | null,
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

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={pageTitle}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...nav} />
      <div class="prose">
        {content ? (
          <Raw html={renderMarkdown(content)} />
        ) : (
          <p>
            <em>{t("public.no_content")}</em>
          </p>
        )}
      </div>
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
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
  websiteTitle?: string | null;
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
    ? `${FEED_DISCOVERY_TAGS}\n<script defer src="${CONTACT_JS_PATH}"></script>`
    : FEED_DISCOVERY_TAGS;

  return String(
    <Layout headExtra={headExtra} title={pageTitle}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...options.nav} />
      <Flash error={options.error} success={options.success} />
      {content && (
        <div class="prose">
          <Raw html={renderMarkdown(content)} />
        </div>
      )}
      {formActive && <ContactForm botpoisonPublicKey={botpoisonPublicKey} />}
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};
