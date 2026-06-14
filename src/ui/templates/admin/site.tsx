/**
 * Admin site page editor templates
 */

import { siteContactForm, siteHomeForm } from "#routes/admin/site.ts";
import { CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** Sub-navigation for site editor pages */
const SiteSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/admin/site">Homepage</a>
      </li>
      <li>
        <a href="/admin/site/contact">Contact</a>
      </li>
    </ul>
  </nav>
);

/**
 * Homepage editor - website title + homepage text
 */
export const adminSiteHomePage = (
  session: AdminSession,
  websiteTitle: string,
  homepageText: string,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Site - Home">
      <AdminNav active="/admin/site" session={session} />
      <SiteSubNav />

      <Flash error={error} success={success} />

      <h2>Home Page</h2>

      <CsrfForm action="/admin/site">
        <Raw
          html={siteHomeForm.render({
            homepage_text: homepageText,
            website_title: websiteTitle,
          })}
        />
        <SubmitButton icon="save">Save</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/**
 * Contact page editor
 */
export const adminSiteContactPage = (
  session: AdminSession,
  contactPageText: string,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Site - Contact">
      <AdminNav active="/admin/site" session={session} />
      <SiteSubNav />

      <Flash error={error} success={success} />

      <h2>Contact Page</h2>

      <CsrfForm action="/admin/site/contact">
        <Raw
          html={siteContactForm.render({
            contact_page_text: contactPageText,
          })}
        />
        <SubmitButton icon="save">Save</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
