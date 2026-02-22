/**
 * Admin site page editor templates
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/** Sub-navigation for site editor pages */
const SiteSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li><a href="/admin/site">Homepage</a></li>
      <li><a href="/admin/site/contact">Contact</a></li>
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
  error: string,
  success: string,
): string =>
  String(
    <Layout title="Site - Home">
      <AdminNav session={session} />
      <SiteSubNav />

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>Home Page</h2>

      <CsrfForm action="/admin/site">
        <label for="website_title">Website Title</label>
        <p><small>Displayed as the main heading on all public pages (max 128 characters).</small></p>
        <input
          type="text"
          id="website_title"
          name="website_title"
          maxlength="128"
          value={websiteTitle ?? ""}
          autocomplete="off"
        />

        <label for="homepage_text">Homepage Text</label>
        <p><small>Text displayed on the public homepage (max 2048 characters). Line breaks will be preserved.</small></p>
        <textarea
          id="homepage_text"
          name="homepage_text"
          rows="4"
          placeholder="Welcome to our site..."
        >{homepageText ?? ""}</textarea>

        <button type="submit">Save</button>
      </CsrfForm>
    </Layout>
  );

/**
 * Contact page editor
 */
export const adminSiteContactPage = (
  session: AdminSession,
  contactPageText: string | null,
  error: string,
  success: string,
): string =>
  String(
    <Layout title="Site - Contact">
      <AdminNav session={session} />
      <SiteSubNav />

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>Contact Page</h2>

      <CsrfForm action="/admin/site/contact">
        <label for="contact_page_text">Contact Page Text</label>
        <p><small>Text displayed on the public contact page (max 2048 characters). Line breaks will be preserved.</small></p>
        <textarea
          id="contact_page_text"
          name="contact_page_text"
          rows="4"
          placeholder="Get in touch with us..."
        >{contactPageText ?? ""}</textarea>

        <button type="submit">Save</button>
      </CsrfForm>
    </Layout>
  );
