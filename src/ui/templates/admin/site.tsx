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

/** State of the optional public contact form feature */
interface ContactFormState {
  /** Whether the host has configured Botpoison (gates the whole section) */
  available: boolean;
  /** Whether the owner has enabled the form */
  enabled: boolean;
  /** Whether a business email is set (required for delivery) */
  hasBusinessEmail: boolean;
}

/** Toggle for the public contact form — only shown when Botpoison is configured */
const ContactFormToggle = ({
  enabled,
  hasBusinessEmail,
}: Omit<ContactFormState, "available">): JSX.Element => (
  <CsrfForm action="/admin/site/contact/form">
    <h2>Contact Form</h2>
    <p>
      Add a spam-protected contact form to the public contact page. Visitors
      enter their email address and a message, which is sent to your business
      email.
    </p>
    {!hasBusinessEmail && (
      <p class="error" role="alert">
        Set a business email on the Settings page to receive contact form
        messages.
      </p>
    )}
    <label>
      <input
        checked={enabled}
        name="contact_form_enabled"
        type="checkbox"
        value="true"
      />{" "}
      Enable contact form
    </label>
    <SubmitButton icon="save">Save</SubmitButton>
  </CsrfForm>
);

/**
 * Contact page editor
 */
export const adminSiteContactPage = (
  session: AdminSession,
  contactPageText: string,
  contactForm: ContactFormState,
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

      {contactForm.available && (
        <ContactFormToggle
          enabled={contactForm.enabled}
          hasBusinessEmail={contactForm.hasBusinessEmail}
        />
      )}
    </Layout>,
  );
