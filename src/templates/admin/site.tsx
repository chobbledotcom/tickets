/**
 * Admin site page editor templates
 */

import { CsrfForm, Flash } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#lib/limits.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";
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
        <label for="website_title">Website Title</label>
        <p>
          <small>
            Displayed as the main heading on all public pages (max 128
            characters).
          </small>
        </p>
        <input
          autocomplete="off"
          id="website_title"
          maxlength="128"
          name="website_title"
          type="text"
          value={websiteTitle}
        />

        <label for="homepage_text">Homepage Text</label>
        <p>
          <small>
            Text displayed on the public homepage (max {MAX_TEXTAREA_LENGTH}{" "}
            characters). <Raw html={FORMATTING_HINT} />
          </small>
        </p>
        <textarea
          id="homepage_text"
          maxlength={MAX_TEXTAREA_LENGTH}
          name="homepage_text"
          placeholder="Welcome to our site..."
        >
          {homepageText}
        </textarea>

        <button type="submit">Save</button>
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
        <label for="contact_page_text">Contact Page Text</label>
        <p>
          <small>
            Text displayed on the public contact page (max {MAX_TEXTAREA_LENGTH}{" "}
            characters). <Raw html={FORMATTING_HINT} />
          </small>
        </p>
        <textarea
          id="contact_page_text"
          maxlength={MAX_TEXTAREA_LENGTH}
          name="contact_page_text"
          placeholder="Get in touch with us..."
        >
          {contactPageText}
        </textarea>

        <button type="submit">Save</button>
      </CsrfForm>
    </Layout>,
  );
