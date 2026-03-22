/**
 * Admin site page editor templates
 */

import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";
import { t } from "#i18n";
import { Layout } from "#templates/layout.tsx";

/** Sub-navigation for site editor pages */
const SiteSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/admin/site">{t("site.sub_nav.homepage")}</a>
      </li>
      <li>
        <a href="/admin/site/contact">{t("site.sub_nav.contact")}</a>
      </li>
    </ul>
  </nav>
);

/**
 * Homepage editor - website title + homepage text
 */
export const adminSiteHomePage = (
  session: AdminSession,
  websiteTitle: string | null,
  homepageText: string | null,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Site - Home">
      <AdminNav session={session} active="/admin/site" />
      <SiteSubNav />

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>{t("site.home.heading")}</h2>

      <CsrfForm action="/admin/site">
        <label for="website_title">{t("site.home.title_label")}</label>
        <p>
          <small>
            {t("site.home.title_hint")}
          </small>
        </p>
        <input
          type="text"
          id="website_title"
          name="website_title"
          maxlength="128"
          value={websiteTitle ?? ""}
          autocomplete="off"
        />

        <label for="homepage_text">{t("site.home.text_label")}</label>
        <p>
          <small>
            {t("site.home.text_hint")}{" "}
            <Raw html={FORMATTING_HINT} />
          </small>
        </p>
        <textarea
          id="homepage_text"
          name="homepage_text"
          rows="4"
          placeholder={t("site.home.text_placeholder")}
        >
          {homepageText ?? ""}
        </textarea>

        <button type="submit">{t("site.home.save")}</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Contact page editor
 */
export const adminSiteContactPage = (
  session: AdminSession,
  contactPageText: string | null,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Site - Contact">
      <AdminNav session={session} active="/admin/site" />
      <SiteSubNav />

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>{t("site.contact.heading")}</h2>

      <CsrfForm action="/admin/site/contact">
        <label for="contact_page_text">{t("site.contact.text_label")}</label>
        <p>
          <small>
            {t("site.contact.text_hint")}{" "}
            <Raw html={FORMATTING_HINT} />
          </small>
        </p>
        <textarea
          id="contact_page_text"
          name="contact_page_text"
          rows="4"
          placeholder={t("site.contact.text_placeholder")}
        >
          {contactPageText ?? ""}
        </textarea>

        <button type="submit">{t("site.contact.save")}</button>
      </CsrfForm>
    </Layout>,
  );
