/**
 * Admin guide page template - FAQ-style help for administrators
 */

import { t } from "#i18n";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
  API_BOOK_REQUEST_JSON,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import { buildDefaultTemplate } from "#shared/column-order.ts";
import {
  ATTENDEE_DEFAULT_ORDER,
  ATTENDEE_TABLE_COLUMNS,
} from "#shared/columns/attendee-columns.ts";
import {
  LISTING_DEFAULT_ORDER,
  LISTING_TABLE_COLUMNS,
} from "#shared/columns/listing-columns.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { LOGIN_LOCKOUT_MS, MAX_LOGIN_ATTEMPTS } from "#shared/limits.ts";
import { type AdminSession, MAX_DURATION_DAYS } from "#shared/types.ts";
import { WEBHOOK_EXAMPLE_JSON } from "#shared/webhook-example.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Host-level configuration info passed from the route */
export type GuideHostConfig = {
  hostEmailProvider: string | null;
  hostEmailFromAddress: string | null;
  hostAppleWalletPassTypeId: string | null;
  hostGoogleWalletIssuerId: string | null;
  builderEnabled: boolean;
  bunnyDnsSubdomainSuffix: string | null;
};

/** Render a column reference table from column generators */
const columnReferenceTable = (
  columns: Record<string, { label: string; description: string }>,
): string => {
  const rows = Object.entries(columns)
    .map(
      ([key, col]) =>
        `<tr>
          <td><code>{{${key}}}</code></td>
          <td>${col.label}</td>
          <td>${col.description}</td>
        </tr>`,
    )
    .join("");
  return [
    "<table>",
    "<thead><tr><th>Tag</th><th>Label</th><th>Description</th></tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
};

const Section = ({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children?: Child;
}): JSX.Element => (
  <div class="stack-md column">
    <h3 id={id}>{title}</h3>
    {children}
  </div>
);

const Q = ({ q, children }: { q: string; children?: Child }): JSX.Element => (
  <details>
    <summary>{q}</summary>
    {children}
  </details>
);

/**
 * Admin guide page
 */
export const adminGuidePage = (
  adminSession: AdminSession,
  hostConfig?: GuideHostConfig,
): string =>
  String(
    <Layout bodyClass="guide" title={t("guide.title")}>
      <AdminNav active="/admin/guide" session={adminSession} />

      <div class="prose">
        <h2>{t("guide.title")}</h2>

        <p class="search-hint">
          Press <kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>&#8984;</kbd>+<kbd>F</kbd>{" "}
          on Mac) to search this page.
        </p>
      </div>

      <Section title={t("guide.sections.getting_started")}>
        <Q q={t("guide.q.create_listing")}>
          <p>
            From the <strong>Listings</strong> page, click{" "}
            <strong>Add Listing</strong>. Give your listing a name, set the
            capacity, and choose which contact details to collect (any
            combination of email, phone, postal address, and special
            instructions &mdash; or none at all for name-only registration). You
            can leave the price blank for free listings. Once created, share the
            booking link with your attendees.
          </p>
        </Q>

        <Q q={t("guide.q.setup_payments")}>
          <p>
            Go to <strong>Settings</strong> and choose Stripe, Square, or SumUp
            as your payment provider. Paste in your API key and save. For Stripe
            and SumUp the webhook is configured automatically. For Square,
            you'll need to copy the webhook URL shown and add it in your Square
            Developer Dashboard.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.dashboard")}>
        <Q q={t("guide.q.what_is_dashboard")}>
          <p>
            The <strong>Listings</strong> page is your dashboard. It lists all
            your listings with attendee counts, booking links, and quick
            actions. At the top, the <strong>Active Listing Statistics</strong>{" "}
            section shows totals across all active listings: total income,
            number of ticket rows, and total attendee quantity. Click the
            heading to expand or collapse it.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.testing_your_system")}>
        <Q q={t("guide.q.test_after_changing_settings")}>
          <p>
            Yes. After changing any setting &mdash; especially payment
            configuration, listing capacity, or booking fields &mdash; you
            should test the full booking process to make sure everything works
            as expected. Create a test listing (or use test payment credentials)
            and complete a booking from start to finish.
          </p>
        </Q>

        <Q q={t("guide.q.report_bug")}>
          <p>
            This project is early in development (started January 2026) and bugs
            are expected. If you find something that doesn&apos;t work
            correctly, please email{" "}
            <a href="mailto:hello@chobble.com">hello@chobble.com</a> with a
            description of what happened and what you expected. The more detail
            you can provide, the faster it can be fixed.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.listings")}>
        <Q q={t("guide.q.standard_vs_daily_listings")}>
          <p>
            A <strong>standard listing</strong> is a one-off &mdash; attendees
            book a place and the capacity applies to the whole listing. A{" "}
            <strong>daily listing</strong> lets attendees pick a specific date
            when booking. The capacity limit applies separately to each date, so
            you can run the same listing every day with a fresh allocation.
          </p>
        </Q>

        <Q q={t("guide.q.combine_multiple_listings")}>
          <p>
            Join listing slugs with a <code>+</code> in the URL, e.g.{" "}
            <code>/ticket/listing-one+listing-two</code>. Attendees see a single
            form, fill in their details once, and book all selected listings in
            one go. If any are paid, they complete one checkout for the total.
          </p>
          <p>
            The attendee gets a single ticket with one QR code covering all
            their listings. Their ticket page shows one card per listing. In the
            admin, they appear as one attendee linked to multiple listings.
          </p>
          <p>
            If the listings have different contact-detail settings, the combined
            form asks for the union of all selected fields &mdash; so pairing an
            email-only listing with one that also collects a phone number will
            require both from every attendee. Fields always appear in the same
            order (email, phone, address, special instructions) regardless of
            which listings are combined.
          </p>
          <p>
            To generate the link, open the <strong>Multi-booking link</strong>{" "}
            section on the <strong>Listings</strong> page and tick the listings
            you want to combine. The link updates as you select, and listings
            appear in the order you tick them.
          </p>
        </Q>

        <Q q={t("guide.q.what_are_groups")}>
          <p>
            Groups let you bundle related listings under a single URL. Create a
            group from the <strong>Groups</strong> page, then assign listings to
            it using the group dropdown on the listing form. Share{" "}
            <code>/ticket/your-group-slug</code> and attendees see all active
            listings in the group on one page. You can optionally set a maximum
            attendee limit on the group to cap total bookings across all
            listings in it. If you add terms and conditions to a group, they
            replace the global T&amp;Cs for that page.
          </p>
        </Q>

        <Q q={t("guide.q.listing_date_and_location")}>
          <p>
            These are optional fields you can fill in when creating or editing a
            listing. The date is when the listing takes place (in your
            configured timezone) and the location is where it's held. Both are
            displayed on the attendee's ticket page so they know when and where
            to go. For daily listings, attendees already pick a date when
            booking, so the listing date field is more useful for standard
            (one-off) listings.
          </p>
        </Q>

        <Q q={t("guide.q.max_tickets_per_purchase")}>
          <p>
            It controls how many tickets one person can book in a single
            transaction. For example, setting it to 4 lets someone book up to 4
            places at once. The quantity dropdown on the booking form won't
            exceed this number or the remaining capacity, whichever is lower.
          </p>
        </Q>

        <Q q={t("guide.q.allow_pay_more")}>
          <p>
            When enabled, attendees can choose their own price instead of paying
            a fixed amount. The ticket price becomes a minimum. You can set a
            maximum price using the "Maximum Price" field — it must be at least{" "}
            {formatCurrency(100)} more than the ticket price. If the ticket
            price is zero, it becomes a pay-what-you-want listing where
            attendees can optionally enter any amount up to the configured
            maximum.
          </p>
        </Q>

        <Q q="What is 'Purchase Only' mode?">
          <p>
            When you enable <strong>Purchase Only</strong> on a listing, it
            becomes a non-attendance purchase &mdash; ideal for raffles,
            fundraisers, donations, or merchandise. The booking button changes
            from &ldquo;Reserve&rdquo; to &ldquo;Buy now&rdquo;, and after
            purchase attendees see &ldquo;Your Purchase&rdquo; instead of
            &ldquo;Your Tickets&rdquo;.
          </p>
          <p>
            Because there is nothing to attend, QR codes, the check-in scanner,
            and wallet passes (Apple &amp; Google) are all hidden. The listing
            is also excluded from the ICS and RSS feeds. Non-transferable ID
            notices are suppressed too, since there is no door to check at.
          </p>
        </Q>

        <Q q={t("guide.q.registration_deadlines")}>
          <p>
            Set a "closes at" date and time on your listing. After that moment,
            the booking form shows a "registration closed" message and no
            further bookings are accepted. If someone loaded the form before the
            deadline but submits after, their booking is also rejected.
          </p>
        </Q>

        <Q q={t("guide.q.embed_booking_form")}>
          <p>
            You only need <strong>one</strong> of the two embed codes shown on
            your listing page &mdash; not both:
          </p>
          <ul>
            <li>
              <strong>Embed Script</strong> (recommended) &mdash; paste a single{" "}
              <code>&lt;script&gt;</code> tag and it creates the iframe for you
              with automatic resizing.
            </li>
            <li>
              <strong>Embed Iframe</strong> &mdash; use this if your hosting
              platform blocks third-party scripts or if you want full control
              over the iframe styling yourself.
            </li>
          </ul>
          <p>
            In <strong>Settings</strong>, add your website's domain to the embed
            hosts list to restrict which sites can embed your forms. If no hosts
            are listed, embedding is allowed from any site.
          </p>
        </Q>

        <Q q={t("guide.q.manually_add_attendee")}>
          <p>
            Open the listing page and scroll down to{" "}
            <strong>Add Attendee</strong>. Fill in the name and contact details,
            set the quantity, and submit. The attendee is added directly without
            needing to go through the booking form or payment flow. Useful for
            walk-ins, comps, or manual corrections.
          </p>
        </Q>

        <Q q={t("guide.q.custom_redirect_after_booking")}>
          <p>
            When creating or editing a listing, enter a URL in the "thank you
            URL" field. After a successful booking or payment, attendees are
            redirected to that address instead of seeing the default
            confirmation page. The URL must use HTTPS, or you can use a relative
            path starting with <code>/</code>.
          </p>
        </Q>

        <Q q={t("guide.q.add_listing_image")}>
          <p>
            When creating or editing a listing, use the image upload field to
            attach a picture. The image is displayed on the booking page and in
            the public listings list. Supported formats are JPEG, PNG, GIF, and
            WebP.
          </p>
        </Q>

        <Q q={t("guide.q.add_file_attachment")}>
          <p>
            When creating or editing a listing, use the attachment upload field
            to attach a file. This can be any type of file &mdash; PDFs, Word
            documents, spreadsheets, images, audio, video, zip archives, you
            name it. The maximum file size is 25&nbsp;MB.
          </p>
          <p>
            Attendees see a download link on their ticket page. The link is
            time-limited and unique to each attendee, so it can't be shared or
            reused by others. Each time an attendee visits their ticket page,
            they get a fresh link that works for a short window.
          </p>
          <p>
            To remove an attachment, open the listing and click{" "}
            <strong>Delete</strong> next to the current file name.
          </p>
        </Q>

        <Q q={t("guide.q.listing_qr_code")}>
          <p>
            On the admin listing page, click the <strong>QR code</strong> link
            next to the public URL. This opens an SVG image of the QR code that
            links to your listing's registration page. You can save or print it
            for posters, flyers, or other materials.
          </p>
        </Q>

        <Q q={t("guide.q.duplicate_listing")}>
          <p>
            Open the listing and click <strong>Duplicate</strong>. This creates
            a new listing pre-filled with the same capacity, price, fields,
            group, and other settings so you can adjust what you need without
            starting from scratch. The name is left blank for you to fill in,
            and the image, attachment, and assigned questions are not copied.
          </p>
        </Q>

        <Q q={t("guide.q.deactivate_listing")}>
          <p>
            Open the listing and click <strong>Deactivate</strong>. Deactivated
            listings no longer accept bookings and are hidden from the public
            listings list, but all existing attendee data is kept. Click{" "}
            <strong>Reactivate</strong> to make the listing bookable again.
          </p>
        </Q>

        <Q q={t("guide.q.non_transferable_tickets")}>
          <p>
            When you enable <strong>Non-Transferable</strong> on a listing,
            attendees see a notice on their ticket saying "Non-transferable — ID
            required at entry". At check-in, the QR scanner prompts door staff
            to verify the attendee's ID matches the name on the ticket before
            completing check-in. This helps prevent ticket touting.
          </p>
        </Q>

        <Q q={t("guide.q.edit_attendee")}>
          <p>
            Open the listing's attendee list, find the attendee, and click{" "}
            <strong>Edit</strong>. The edit page has three sections:
          </p>
          <ul>
            <li>
              <strong>Contact Information</strong> &mdash; name, email, phone,
              address, special instructions, and custom question answers. These
              are shared across all the attendee's listing registrations.
            </li>
            <li>
              <strong>Listing Registrations</strong> &mdash; a table showing
              each listing the attendee is registered for, with their quantity,
              check-in status, and refund status. You can update the quantity
              per listing or remove a registration.
            </li>
            <li>
              <strong>Add to Listing</strong> &mdash; link the attendee to an
              additional listing. For daily listings, you also pick a date.
              Capacity is checked when adding.
            </li>
          </ul>
        </Q>

        <Q q="How do I add an attendee to another listing?">
          <p>
            Open the attendee's edit page and use the{" "}
            <strong>Add to Listing</strong> section at the bottom. Select the
            listing, choose a quantity, and for daily listings pick a date. If
            the listing has enough capacity the attendee is linked immediately.
          </p>
        </Q>

        <Q q="How do I remove an attendee from a listing?">
          <p>
            On the attendee's edit page, find the listing in the{" "}
            <strong>Listing Registrations</strong> table and click{" "}
            <strong>Remove</strong>. If the attendee is registered for other
            listings they stay in the system. If it was their only listing, the
            attendee is deleted entirely.
          </p>
        </Q>

        <Q q="How do I delete an attendee?">
          <p>
            Open the listing's attendee list and click <strong>Delete</strong>{" "}
            next to the attendee. You'll see a confirmation page showing their
            name, email, quantity, and registration date. Type the attendee's
            exact name to confirm, then click <strong>Delete Attendee</strong>.
            This permanently removes the attendee and any associated payment
            records.
          </p>
          <p>
            If the attendee has paid, <strong>refund them first</strong> before
            deleting &mdash; once deleted, there is no payment record to refund
            against. See the <strong>Refunds</strong> section below.
          </p>
        </Q>

        <Q q="How do I merge duplicate attendees?">
          <p>
            If the same person booked separately and ended up with two attendee
            records, you can merge them. Open one attendee's edit page and find
            the <strong>Merge</strong> section. Enter the other attendee's
            ticket token to start the merge.
          </p>
          <p>
            You'll see a comparison of their contact details, custom question
            answers, and listing registrations. For each conflict &mdash; where
            the two records differ &mdash; choose which value to keep. Non-
            conflicting data (e.g. an answer only one of them provided) is
            adopted automatically. Once confirmed, the source attendee is
            deleted and all chosen data is merged into the target.
          </p>
        </Q>

        <Q q="How do I resend a confirmation email?">
          <p>
            In the listing's attendee list, click{" "}
            <strong>Re-send Notification</strong> next to the attendee. You'll
            be asked to type their name to confirm. This re-sends both the
            attendee confirmation email (with their ticket link) and the admin
            notification email. If email is not configured or the attendee has
            no email address, the action completes silently without sending.
          </p>
        </Q>

        <Q q={t("guide.q.add_terms_and_conditions")}>
          <p>
            In <strong>Settings</strong>, enter your terms in the "Terms and
            Conditions" box. When set, attendees must tick an agreement checkbox
            before they can reserve tickets. Clear the box to remove the
            requirement.
          </p>
        </Q>
      </Section>

      <Section id="questions" title={t("guide.sections.booking_questions")}>
        <Q q={t("guide.q.what_are_custom_booking_questions")}>
          <p>
            Custom booking questions let you ask attendees a multiple-choice
            question during the booking process. Each question has a set of
            answers you define, and the attendee must select one before they can
            complete their booking.
          </p>
        </Q>

        <Q q={t("guide.q.create_question")}>
          <p>
            Open any listing and click <strong>Questions</strong> in the listing
            menu, then follow the <strong>Manage Questions</strong> link. Type
            your question text and click <strong>Add Question</strong>. Then
            open the question and add your answer options. You can reorder
            answers using the move-up and move-down buttons.
          </p>
        </Q>

        <Q q={t("guide.q.add_question_to_listing")}>
          <p>
            Open the listing in the admin area and click{" "}
            <strong>Questions</strong>. Tick the questions you want to appear on
            that listing's booking form and save. The same question can be
            shared across multiple listings &mdash; create it once and assign it
            wherever you need it.
          </p>
        </Q>

        <Q q={t("guide.q.share_questions_between_listings")}>
          <p>
            Yes. Questions are created independently and then assigned to
            listings, so a single question can appear on as many listings as you
            like. Updating the question text or answers updates it everywhere
            it's used.
          </p>
        </Q>

        <Q q={t("guide.q.where_to_see_answers")}>
          <p>
            Answers appear in the attendee table on listing and group pages, so
            you can see at a glance what each attendee chose. They're also shown
            on the individual attendee detail page and included in the CSV
            export.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.public_links")}>
        <Q q={t("guide.q.facebook_403_error")}>
          <p>
            When you first share a link from a new domain on Facebook, Facebook
            may return a 403 error. This is because Facebook doesn't recognise
            the domain yet &mdash; the error comes from Facebook itself and
            doesn't even reach your site.
          </p>
          <p>
            To fix this, paste your public link into the{" "}
            <a href="https://developers.facebook.com/tools/debug/">
              Facebook Sharing Debugger
            </a>{" "}
            and click <strong>Scrape Again</strong> if the result looks wrong.
            Once Facebook has successfully scraped the URL, future shares should
            work normally.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.public_site")}>
        <Q q={t("guide.q.what_is_public_site")}>
          <p>
            When enabled in <strong>Settings</strong>, your domain shows a
            public website with navigation for Home and Listings, plus T&amp;Cs
            and Contact links if you've set those up. The{" "}
            <strong>Listings</strong> page lists all active listings with
            booking links. Visitors can browse listing details and book
            directly. If the public site is disabled, visitors can still book
            via direct ticket links.
          </p>
        </Q>

        <Q q={t("guide.q.hide_listing_from_public_list")}>
          <p>
            Yes. When editing a listing, tick the{" "}
            <strong>Hidden Listing</strong> checkbox. Hidden listings won&apos;t
            appear on the public Listings page and their ticket pages will be
            marked as <code>noindex, nofollow</code> for search engines. The
            listing is still fully bookable via its direct link or when embedded
            in an iframe.
          </p>
        </Q>

        <Q q={t("guide.q.edit_homepage_and_contact")}>
          <p>
            Enable the public site in <strong>Settings</strong>, then open the{" "}
            <strong>Site</strong> section from the admin navigation. The
            homepage editor lets you set a website title (shown as the heading
            on all public pages) and homepage text. The contact page editor lets
            you set contact information. Both fields support Markdown
            formatting.
          </p>
        </Q>
      </Section>

      <Section id="text-formatting" title={t("guide.sections.text_formatting")}>
        <Q q={t("guide.q.fields_support_formatting")}>
          <p>
            Listing descriptions, terms and conditions, homepage text, and
            contact page text all support{" "}
            <a href="https://www.markdownguide.org/cheat-sheet/">Markdown</a>{" "}
            formatting.
          </p>
        </Q>

        <Q q={t("guide.q.what_formatting_can_i_use")}>
          <p>
            <strong>Bold</strong> with <code>**bold**</code>, <em>italic</em>{" "}
            with <code>*italic*</code>, links with{" "}
            <code>[text](https://...)</code>, and lists with <code>-</code> at
            the start of a line. See the{" "}
            <a href="https://www.markdownguide.org/cheat-sheet/">
              Markdown cheat sheet
            </a>{" "}
            for more options.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.payments")}>
        <Q q={t("guide.q.supported_payment_providers")}>
          <p>
            <strong>Stripe</strong>, <strong>Square</strong>, and{" "}
            <strong>SumUp</strong>. Choose one in Settings and enter your API
            credentials. You can switch between them at any time.
          </p>
          <p>
            <strong>SumUp</strong> only works with a limited set of currencies
            (mostly European currencies plus GBP, USD, and BRL). If your site
            currency isn't supported, the Settings page will refuse the
            credentials and tell you to pick a different provider or country.
          </p>
        </Q>

        <Q q={t("guide.q.recommended_payment_provider")}>
          <p>
            <strong>Stripe</strong>. The setup is a fair bit easier &mdash; you
            just paste in your secret key and the webhook is created
            automatically. <strong>SumUp</strong> is similarly quick (an API key
            and merchant code, with the webhook handled for you), but it's
            limited to certain currencies. With <strong>Square</strong> you need
            to create a developer application, find your location ID, and
            manually configure the webhook yourself. All three work well once
            set up, but Stripe gets you going faster.
          </p>
        </Q>

        <Q q={t("guide.q.paid_ticket_booking_flow")}>
          <p>
            They fill in the booking form, then are redirected to your payment
            provider's checkout page. Once their payment is confirmed, their
            place is recorded and they receive their ticket. Their place is
            <strong>not</strong> held while they're paying &mdash; see{" "}
            <em>Why don't we hold places during checkout?</em> below for the
            reason.
          </p>
        </Q>

        <Q q="Why don't we hold places during checkout?">
          <p>
            When someone clicks &ldquo;Buy&rdquo;, we don't reserve their place
            while they're paying. A place only counts as taken once the payment
            goes through. This might sound backwards, so here's why.
          </p>
          <p>
            Imagine if we <em>did</em> hold places during checkout. A sneaky
            person could write a small program that opens the checkout page over
            and over, grabbing every place, without ever paying. Real visitors
            would see &ldquo;sold out&rdquo; even though nobody had actually
            bought anything. When the holds expired, the program could grab them
            all again. This is how ticket scalpers cause problems on bigger
            sites.
          </p>
          <p>
            Because places only count once payment is finished, the only way to
            &ldquo;hold&rdquo; a place is to actually pay for it. Real money has
            to change hands &mdash; so the trick above doesn't work, and real
            visitors get a fair chance at the tickets.
          </p>
          <p>
            The trade-off: very rarely, two people can finish paying for the
            last place at almost the same moment. The first payment to arrive
            wins; the second person is automatically refunded. See the next
            question.
          </p>
        </Q>

        <Q q={t("guide.q.listing_sells_out_while_paying")}>
          <p>
            If someone completes payment but the listing has since sold out,
            they are automatically refunded. They'll see a message explaining
            the listing is full and that their payment has been returned. This
            is rare but possible &mdash; it's the trade-off described in the
            previous question.
          </p>
        </Q>

        <Q q={t("guide.q.how_refunds_work")}>
          <p>
            See the <strong>Refunds</strong> section below for full details on
            automatic refunds, admin-issued refunds, and bulk refunds.
          </p>
        </Q>

        <Q q={t("guide.q.what_is_booking_fee")}>
          <p>
            The booking fee is an optional percentage-based charge added to
            ticket prices at checkout. For example, if you set a 2% booking fee
            on a {formatCurrency(1000)} ticket, the attendee pays{" "}
            {formatCurrency(1020)} in total.
          </p>
          <p>
            Configure it in <a href="/admin/settings">Settings</a> under{" "}
            <strong>Booking Fee</strong> (only visible when a payment provider
            is set up). Enter a percentage between 0 and 10. Set it to 0 or
            leave it blank to disable. The fee is calculated on the subtotal and
            added automatically during checkout.
          </p>
        </Q>
      </Section>

      <Section id="payment-setup" title={t("guide.sections.payment_setup")}>
        <Q q={t("guide.q.find_stripe_secret_key")}>
          <ol>
            <li>
              Log in to your{" "}
              <a href="https://dashboard.stripe.com">Stripe Dashboard</a>
            </li>
            <li>
              Click <strong>Developers</strong> in the navigation menu
            </li>
            <li>
              Select <strong>API keys</strong> from the sidebar
            </li>
            <li>
              Under <strong>Standard keys</strong>, find the{" "}
              <strong>Secret key</strong> row and click <strong>Reveal</strong>
            </li>
            <li>
              Copy the key &mdash; it starts with <code>sk_live_</code> for live
              mode or <code>sk_test_</code> for test mode
            </li>
            <li>
              Paste it into the Stripe Secret Key field on the{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
          <p>
            <strong>Tip:</strong> Use a <code>sk_test_</code> key first to
            verify everything works before switching to your live key. Test mode
            lets you make bookings without real charges.
          </p>
        </Q>

        <Q q={t("guide.q.stripe_webhook_setup")}>
          <p>
            No. When you save your Stripe secret key in{" "}
            <a href="/admin/settings">Settings</a>, the system automatically
            creates a webhook endpoint in your Stripe account and stores the
            signing secret. You can verify it's working by clicking the{" "}
            <strong>Test Connection</strong> button that appears after saving
            your key.
          </p>
        </Q>

        <Q q={t("guide.q.create_square_application")}>
          <p>
            Before you can accept payments with Square, you need to create an
            application in the Square Developer Dashboard. This gives you the
            API credentials the system needs.
          </p>
          <ol>
            <li>
              Go to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and sign in with your Square account
            </li>
            <li>
              Click the <strong>+</strong> button to create a new application
            </li>
            <li>
              Give it a name (e.g. your organisation or listing name) and click{" "}
              <strong>Save</strong>
            </li>
          </ol>
          <p>
            Once created, you can find your access token and location ID from
            the application's pages (see below).
          </p>
        </Q>

        <Q q={t("guide.q.find_square_access_token")}>
          <ol>
            <li>
              Log in to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>
            </li>
            <li>Select your application</li>
            <li>
              Open the <strong>Credentials</strong> page
            </li>
            <li>
              Copy the <strong>Access token</strong> for the environment you
              want (Sandbox for testing, Production for real payments)
            </li>
            <li>
              Paste it into the Square Access Token field on the{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
        </Q>

        <Q q={t("guide.q.find_square_location_id")}>
          <ol>
            <li>
              Log in to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and select your application
            </li>
            <li>
              Open the <strong>Locations</strong> page in the sidebar
            </li>
            <li>
              Copy the <strong>Location ID</strong> for the location you want to
              accept payments at
            </li>
          </ol>
          <p>
            You can also find your location ID in the main{" "}
            <a href="https://squareup.com/dashboard">Square Dashboard</a> under{" "}
            <strong>Account &amp; Settings</strong> &rarr;{" "}
            <strong>Business information</strong> &rarr;{" "}
            <strong>Locations</strong>.
          </p>
        </Q>

        <Q q={t("guide.q.setup_square_webhook")}>
          <p>
            Unlike Stripe, the Square webhook must be configured manually. After
            saving your Square access token and location ID:
          </p>
          <ol>
            <li>
              Go to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and select your application
            </li>
            <li>
              Navigate to <strong>Webhooks</strong> in the sidebar
            </li>
            <li>
              Click <strong>Add Subscription</strong>
            </li>
            <li>
              Set the <strong>Notification URL</strong> to the webhook URL shown
              on your <a href="/admin/settings">Settings</a> page
            </li>
            <li>
              Subscribe to the <strong>payment.updated</strong> event
            </li>
            <li>
              Save the subscription, then copy the{" "}
              <strong>Signature Key</strong> that Square provides
            </li>
            <li>
              Paste the signature key into the webhook field on your{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
          <p>
            The webhook is what tells the system when a payment has been
            completed, so bookings won't be confirmed until this is set up.
          </p>
        </Q>

        <Q q="How do I set up SumUp?">
          <p>
            SumUp uses its Hosted Checkout, and the webhook is handled
            automatically &mdash; there's nothing to configure in the SumUp
            dashboard. You need two values:
          </p>
          <ol>
            <li>
              <strong>API Key</strong> &mdash; a secret API key from your SumUp
              account, starting with <code>sk_live_</code> (real payments) or{" "}
              <code>sk_test_</code> (testing). Create one under{" "}
              <strong>Developers</strong> &rarr; <strong>API keys</strong> in
              the SumUp dashboard.
            </li>
            <li>
              <strong>Merchant Code</strong> &mdash; your SumUp merchant code
              (e.g. <code>MC...</code>), shown in your SumUp dashboard.
            </li>
          </ol>
          <p>
            Paste both into the SumUp section on the{" "}
            <a href="/admin/settings">Settings</a> page and save. As with
            Stripe, the Settings page shows a <strong>Test mode</strong> or{" "}
            <strong>Live mode</strong> badge based on your key prefix, and a{" "}
            <strong>Test Connection</strong> button to verify it works.
          </p>
          <p>
            SumUp only supports certain currencies. If your site currency isn't
            one of them, saving the credentials is blocked with a message asking
            you to choose a different provider or country.
          </p>
        </Q>

        <Q q={t("guide.q.stripe_test_vs_live_keys")}>
          <p>
            Stripe provides two completely separate environments, each with its
            own set of API keys:
          </p>
          <ul>
            <li>
              <strong>Test mode</strong> (<code>sk_test_</code> /{" "}
              <code>pk_test_</code>) &mdash; a sandbox environment for
              development and testing. No real money is moved. You can use{" "}
              <a href="https://docs.stripe.com/testing#cards">
                Stripe&apos;s test card numbers
              </a>{" "}
              to simulate successful and failed payments. Bookings created in
              test mode won&apos;t appear in your live Stripe dashboard.
            </li>
            <li>
              <strong>Live mode</strong> (<code>sk_live_</code> /{" "}
              <code>pk_live_</code>) &mdash; the production environment. Real
              cards are charged and real money is transferred to your Stripe
              account.
            </li>
          </ul>
          <p>
            The system detects which mode you are in based on the key prefix and
            shows it on the <a href="/admin/settings">Settings</a> page. Only
            keys with a valid prefix (<code>sk_test_</code> or{" "}
            <code>sk_live_</code>) are accepted.
          </p>
        </Q>

        <Q q={t("guide.q.test_or_live_credentials")}>
          <p>
            Start with test credentials to make sure everything is working
            before accepting real payments. All three providers offer separate
            test environments:
          </p>
          <ul>
            <li>
              <strong>Stripe:</strong> Use a key starting with{" "}
              <code>sk_test_</code>. You can make test payments with{" "}
              <a href="https://docs.stripe.com/testing#cards">
                Stripe&apos;s test card numbers
              </a>
              . The Settings page will show a <strong>Test mode</strong> badge
              so you always know which environment is active.
            </li>
            <li>
              <strong>Square:</strong> Use your Sandbox access token and
              location, and tick the <strong>Sandbox mode</strong> checkbox on
              the Settings page. You can make test payments with{" "}
              <a href="https://developer.squareup.com/docs/devtools/sandbox/payments">
                Square&apos;s sandbox test values
              </a>
              . Untick Sandbox mode when switching to production.
            </li>
            <li>
              <strong>SumUp:</strong> Use an API key starting with{" "}
              <code>sk_test_</code>. As with Stripe, the Settings page shows a{" "}
              <strong>Test mode</strong> badge so you know which environment is
              active. Swap to your <code>sk_live_</code> key to go live.
            </li>
          </ul>
          <p>
            When you&apos;re ready to go live, replace the test credentials with
            your production credentials in{" "}
            <a href="/admin/settings">Settings</a>. For Stripe, the system will
            only accept keys that start with a valid prefix (
            <code>sk_test_</code> or <code>sk_live_</code>).
          </p>
        </Q>
      </Section>

      <Section id="refunds" title={t("guide.sections.refunds")}>
        <Q q={t("guide.q.automatic_refunds")}>
          <p>
            A place is only ever counted once payment completes &mdash; nothing
            is held during checkout (see{" "}
            <em>Why don't we hold places during checkout?</em> above). Because
            of that, a completed payment can occasionally find that the booking
            is no longer possible, and in those cases the payment is refunded
            automatically. This happens when, by the time the payment is
            confirmed:
          </p>
          <ul>
            <li>
              the listing has <strong>sold out</strong> &mdash; another buyer
              took the last spot first, so the slower payer is refunded and
              shown a message explaining the listing is full;
            </li>
            <li>
              the <strong>price has changed</strong> &mdash; an admin edited the
              listing price mid-checkout, so the amount charged no longer
              matches the current price;
            </li>
            <li>
              the listing has been <strong>closed or deactivated</strong> while
              the buyer was paying.
            </li>
          </ul>
          <p>
            In multi-listing bookings it's all-or-nothing: if any single listing
            fails (e.g. one of the combined listings is full or its price
            changed), the entire payment is refunded &mdash; not just the
            portion for the affected listing.
          </p>
        </Q>

        <Q q={t("guide.q.refund_individual_attendee")}>
          <p>
            Open the listing's attendee list, find the attendee, and click{" "}
            <strong>Refund</strong>. You'll see a confirmation page showing
            their name, email, quantity, and the amount paid. Type the
            attendee's name to confirm and submit. The refund is issued through
            your payment provider (Stripe, Square, or SumUp) and is always a
            full refund.
          </p>
        </Q>

        <Q q={t("guide.q.refund_all_attendees")}>
          <p>
            On the listing page, click <strong>Refund All</strong> in the
            navigation bar. Type the listing name to confirm. Each attendee with
            a recorded payment is refunded one by one. If some refunds fail
            (e.g. a payment was already refunded via the provider dashboard),
            you'll see a summary of how many succeeded and how many failed.
          </p>
        </Q>

        <Q q={t("guide.q.partial_refunds")}>
          <p>
            No. The system always issues a full refund for the total amount
            paid. If you need to issue a partial refund, do it directly through
            your payment provider's dashboard (Stripe, Square, or SumUp).
          </p>
        </Q>

        <Q q="Is the booking fee refunded too?">
          <p>
            Yes. Refunds reverse the full charge taken from the attendee,
            including any booking fee that was added at checkout. Your payment
            provider's own processing fee is a separate matter &mdash; Stripe
            and Square each have their own policy on whether processing fees are
            returned on a refund, so check your provider for details.
          </p>
        </Q>

        <Q q={t("guide.q.attendee_after_refund")}>
          <p>
            The attendee <strong>remains registered</strong>. A refund only
            clears their payment record &mdash; it does not remove them from the
            listing. If you also want to remove them, delete the attendee
            separately after refunding.
          </p>
          <p>
            Refunds are per-listing. If the attendee is registered for multiple
            listings, refunding one listing does not affect their other
            registrations.
          </p>
        </Q>

        <Q q={t("guide.q.refund_free_listing")}>
          <p>
            No. The Refund button only appears for attendees who have a recorded
            payment. Free-listing attendees have no payment to refund.
          </p>
        </Q>

        <Q q={t("guide.q.refund_fails")}>
          <p>
            The most common reason is that the payment was already refunded
            directly through Stripe, Square, or SumUp. You'll see an error
            message like "Refund failed. The payment may have already been
            refunded." If your payment provider is no longer configured, refunds
            will also fail because there's no provider to process them through.
          </p>
        </Q>

        <Q q={t("guide.q.refund_same_attendee_twice")}>
          <p>
            No. After a successful refund the attendee's payment record is
            cleared, so the Refund button no longer appears. If you attempt to
            refund a payment that was already refunded via the provider
            dashboard, the provider will reject it and you'll see a failure
            message.
          </p>
        </Q>
      </Section>

      <Section
        id="holidays"
        title={t("guide.sections.daily_listings_and_holidays")}
      >
        <Q q={t("guide.q.how_daily_listings_work")}>
          <p>
            Daily listings let attendees choose a specific date when booking.
            You set which days of the week are available (e.g. Monday to
            Friday), the minimum number of days before a date can be booked, and
            the maximum number of days into the future to show. The capacity
            limit applies independently to each date.
          </p>
        </Q>

        <Q q={t("guide.q.what_are_bookable_days")}>
          <p>
            These are the days of the week your daily listing runs on. If you
            only tick Monday and Wednesday, those are the only days that appear
            in the date picker. Weekends and unticked days are skipped.
          </p>
        </Q>

        <Q q="What is the Booking Duration field?">
          <p>
            For daily listings, <strong>Booking Duration (days)</strong> sets
            how many consecutive days a single booking reserves &mdash; useful
            for multi-night stays or multi-day passes. Leave it at 1 for a
            normal single-day booking, or set it up to {MAX_DURATION_DAYS} days.
            The attendee picks a start date and their booking spans that many
            days from it.
          </p>
          <p>
            Capacity is checked for <strong>every</strong> day the booking
            covers, so a place is only confirmed if all of those days have room.
            On the ticket and in the attendee table, the booking shows as a date
            range rather than a single day. The field only appears on daily
            listings &mdash; standard (one-off) listings don't use it.
          </p>
          <p>
            If you change the duration on a listing that already has bookings,
            the system recalculates the date range of every existing booking and
            warns you before saving, since this can affect how many places each
            day has left.
          </p>
        </Q>

        <Q q={t("guide.q.what_are_holidays")}>
          <p>
            Holidays are date ranges when no daily listings can be booked. Add
            them from the <strong>Holidays</strong> page. Any dates falling
            within a holiday range are removed from the booking calendar for all
            daily listings.
          </p>
        </Q>
      </Section>

      <Section id="checkin" title={t("guide.sections.check_in_and_qr_scanner")}>
        <Q q={t("guide.q.how_checkin_works")}>
          <p>
            Each ticket has a unique QR code. When an attendee arrives, they
            show their QR code to a member of staff. The staff member scans it
            (or opens the link), which takes them to the check-in page. If
            logged in as an admin, they'll see the attendee's details and ticket
            quantity, with a button to check them in or out.
          </p>
          <p>
            Check-in is per-listing. If an attendee is registered for multiple
            listings, checking them in at one listing doesn't affect their
            status at other listings.
          </p>
        </Q>

        <Q q={t("guide.q.qr_code_purpose")}>
          <p>
            The QR code links to the ticket's check-in page. Scanning it opens
            the page in a browser. Non-admin visitors see a message to show the
            code to staff. Admin visitors see the attendee's details and a
            check-in button.
          </p>
        </Q>

        <Q q={t("guide.q.use_qr_scanner")}>
          <p>
            Open a listing and click <strong>Scanner</strong>. Tap{" "}
            <strong>Start Camera</strong> to begin (grants camera permission on
            first use). Point the camera at an attendee's QR code and check-in
            happens automatically. The scanner works best with the rear camera
            on mobile devices.
          </p>
        </Q>

        <Q q={t("guide.q.scanner_no_checkout")}>
          <p>
            The scanner is intentionally one-way: it only checks people{" "}
            <strong>in</strong>, never out. This prevents accidental check-outs
            from double-scans at a busy door. To check someone out, use the
            manual check-in page instead.
          </p>
        </Q>

        <Q q={t("guide.q.qr_different_listing")}>
          <p>
            The scanner checks all of the attendee's listing registrations. If
            they're registered for the listing you're scanning, check-in
            proceeds normally. If they're only registered for other listings,
            you'll be prompted to confirm before checking them in. This lets you
            handle last-minute listing changes without turning anyone away.
          </p>
        </Q>

        <Q q={t("guide.q.scanner_status_messages")}>
          <p>
            <strong>Checked in</strong> &mdash; shows the attendee's name and
            ticket count (e.g. "Jo checked in (2 tickets)").{" "}
            <strong>Already checked in</strong> &mdash; they were already marked
            as arrived. <strong>Refunded</strong> &mdash; the attendee has been
            refunded and cannot be checked in. <strong>Ticket not found</strong>{" "}
            &mdash; the QR code doesn't match any registration.{" "}
            <strong>Different listing</strong> &mdash; a confirmation dialogue
            asks whether to check them in anyway.{" "}
            <strong>ID verification</strong> &mdash; for non-transferable
            listings, staff are asked to confirm the attendee's ID matches the
            ticket name before check-in proceeds.
          </p>
        </Q>

        <Q q="What if someone doesn't have their QR code?">
          <p>
            Below the camera on the Scanner page there is a{" "}
            <strong>Manual Check-in</strong> section. Start typing the
            attendee's name or ticket token and a dropdown shows matching
            tickets that haven't been checked in yet. Select the right person
            and click <strong>Check In</strong>. This is useful for walk-ins or
            when an attendee can't pull up their ticket on their phone.
          </p>
        </Q>

        <Q q="How do I filter attendees by check-in status?">
          <p>
            On the listing page, above the attendee table, you'll see filter
            links for <strong>All</strong>, <strong>Checked In</strong>, and{" "}
            <strong>Checked Out</strong>. Click one to show only attendees
            matching that status. The filter works alongside the date selector
            for daily listings, so you can view e.g. only un-checked-in
            attendees for a specific date. The CSV export reflects whichever
            filter is active.
          </p>
        </Q>
      </Section>

      <Section id="apple-wallet" title={t("guide.sections.apple_wallet")}>
        <Q q={t("guide.q.what_is_apple_wallet")}>
          <p>
            When configured, attendees see an{" "}
            <strong>Add to Apple Wallet</strong> button on their ticket page.
            Tapping it downloads a <code>.pkpass</code> file that adds the
            ticket to their iPhone Wallet and Apple Watch. The pass shows the
            listing name, date, location, ticket quantity, price paid, and a QR
            code for check-in.
          </p>
        </Q>

        <Q q={t("guide.q.setup_apple_wallet")}>
          {hostConfig?.hostAppleWalletPassTypeId && (
            <p>
              Apple Wallet is already configured by your server administrator
              using pass type{" "}
              <code>{hostConfig.hostAppleWalletPassTypeId}</code>. The Add to
              Apple Wallet button should appear automatically on all ticket
              pages. You can override this by entering your own credentials in{" "}
              <a href="/admin/settings">Settings</a>.
            </p>
          )}
          <p>
            Go to <a href="/admin/settings">Settings</a>, click{" "}
            <strong>Advanced Settings</strong>, and find the{" "}
            <strong>Apple Wallet</strong> section. You need five values from
            your Apple Developer account:
          </p>
          <ol>
            <li>
              <strong>Pass Type ID</strong> &mdash; e.g.{" "}
              <code>pass.com.example.tickets</code>
            </li>
            <li>
              <strong>Team ID</strong> &mdash; your Apple Developer Team ID
            </li>
            <li>
              <strong>Signing Certificate</strong> &mdash; PEM-encoded
              certificate for your Pass Type ID
            </li>
            <li>
              <strong>Signing Key</strong> &mdash; PEM-encoded private key for
              the certificate
            </li>
            <li>
              <strong>WWDR Certificate</strong> &mdash; Apple's intermediate
              certificate (download from the Apple Developer portal)
            </li>
          </ol>
          <p>
            All five fields are required. Once saved, the Add to Apple Wallet
            button appears automatically on all ticket pages. If none are
            configured, the feature is simply hidden.
          </p>
        </Q>

        <Q q={t("guide.q.wallet_passes_update")}>
          <p>
            Yes. Apple Wallet periodically polls the server (roughly once a day)
            and re-downloads the pass with the latest details. There are no push
            notifications &mdash; updates arrive on Apple's polling schedule.
            Attendees can also pull down on the pass in Wallet to force an
            immediate refresh.
          </p>
        </Q>
      </Section>

      <Section id="google-wallet" title="Google Wallet">
        <Q q="What is Google Wallet integration?">
          <p>
            When configured, attendees see an{" "}
            <strong>Add to Google Wallet</strong> button on their ticket page.
            Tapping it adds the ticket to their Android device's Google Wallet
            app. The pass shows the listing name, date, location, ticket
            quantity, price paid, and a QR code for check-in.
          </p>
        </Q>

        <Q q="How do I set up Google Wallet?">
          {hostConfig?.hostGoogleWalletIssuerId && (
            <p>
              Google Wallet is already configured by your server administrator
              using issuer ID <code>{hostConfig.hostGoogleWalletIssuerId}</code>
              . The Add to Google Wallet button should appear automatically on
              all ticket pages. You can override this by entering your own
              credentials in <a href="/admin/settings">Settings</a>.
            </p>
          )}
          <p>
            Go to <a href="/admin/settings">Settings</a>, click{" "}
            <strong>Advanced Settings</strong>, and find the{" "}
            <strong>Google Wallet</strong> section. You need three values from
            your Google Cloud account:
          </p>
          <ol>
            <li>
              <strong>Issuer ID</strong> &mdash; from the{" "}
              <a href="https://pay.google.com/business/console/">
                Google Wallet Business Console
              </a>
            </li>
            <li>
              <strong>Service Account Email</strong> &mdash; a Google Cloud
              service account with the Google Wallet API enabled
            </li>
            <li>
              <strong>Service Account Private Key</strong> &mdash; PEM-encoded
              RSA private key for the service account
            </li>
          </ol>
          <p>
            All three fields are required. Once saved, the Add to Google Wallet
            button appears automatically on all ticket pages. If none are
            configured, the feature is simply hidden.
          </p>
        </Q>

        <Q q="Do Google Wallet passes update automatically?">
          <p>
            No. Unlike Apple Wallet, Google Wallet passes are generated as a
            one-time snapshot when the attendee adds them. If listing details
            change later, the pass in the attendee&apos;s wallet won&apos;t
            update. The attendee can remove and re-add the pass from their
            ticket page to get the latest details.
          </p>
        </Q>
      </Section>

      <Section
        id="user-classes"
        title={t("guide.sections.users_and_permissions")}
      >
        <Q q={t("guide.q.owner_vs_manager")}>
          <p>
            <strong>Owners</strong> have full access: listings, calendar,
            groups, questions, holidays, users, site pages, settings, API keys,
            sessions, and the activity log. <strong>Managers</strong> can manage
            listings, view the calendar, manage groups, issue refunds, and view
            the activity log. They cannot change settings, manage users, manage
            questions or holidays, create API keys, edit site pages, or view
            sessions.
          </p>
        </Q>

        <Q q={t("guide.q.invite_admin")}>
          <p>
            Go to <strong>Users</strong>, enter a username and choose their role
            (owner or manager). You'll receive an invite link to send them. They
            use the link to set their password and activate their account.
          </p>
        </Q>

        <Q q={t("guide.q.invite_link_expiry")}>
          <p>
            Invite links expire after <strong>7 days</strong>. If the link
            expires before the person uses it, you'll need to delete the pending
            user and create a new invite.
          </p>
        </Q>
      </Section>

      <Section id="login-security" title="Login &amp; Security">
        <Q q="What happens if I enter the wrong password?">
          <p>
            After <strong>5 failed login attempts</strong> from the same IP
            address, the system locks out that IP for{" "}
            <strong>15 minutes</strong>. During the lockout, all login attempts
            from that IP are rejected &mdash; even with the correct password.
            Wait for the lockout period to pass and try again.
          </p>
        </Q>

        <Q q="Why am I locked out even though my password is correct?">
          <p>
            You've likely hit the rate limit from previous failed attempts. The
            lockout applies to your IP address, not your account, so other
            admins logging in from different locations are not affected. Wait 15
            minutes and try again.
          </p>
        </Q>

        <Q q="Is there a way to recover a lost password?">
          <p>
            No. There is <strong>no password recovery</strong> mechanism. All
            attendee data is encrypted with keys derived from admin passwords,
            so a reset would make existing data unreadable. If you lose your
            password, another owner can delete your account and send a fresh
            invite &mdash; all existing attendee data remains accessible to
            other admins. Keep your password somewhere safe.
          </p>
        </Q>

        <Q q="How are admin sessions secured?">
          <p>
            Sessions use HttpOnly cookies that cannot be read by JavaScript.
            Each session expires after <strong>24 hours</strong>, after which
            you must log in again. You can view all active sessions and log out
            all other sessions from the <strong>Sessions</strong> page if you
            suspect your account has been compromised.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.data_and_privacy")}>
        <Q q={t("guide.q.attendee_data_protection")}>
          <p>
            All personal information (names, email addresses, phone numbers,
            postal addresses) is encrypted before being stored. Even if the
            database were compromised, the data cannot be read without the
            encryption keys. Data is only decrypted when an authenticated admin
            views it.
          </p>
        </Q>

        <Q q={t("guide.q.lost_password")}>
          <p>
            There is <strong>no password recovery</strong>. If you lose your
            password, you cannot log in or decrypt any data. Keep your password
            safe. Another owner can delete your account and send a fresh invite,
            and all existing attendee data remains accessible to other admins.
          </p>
        </Q>

        <Q q={t("guide.q.export_attendee_data")}>
          <p>
            Yes. On any listing's attendee list, click{" "}
            <strong>Export CSV</strong>. The export includes name, email, phone,
            address, special instructions, quantity, registration date, amount
            paid, transaction ID, check-in status, ticket token, and ticket URL.
            If the listing has custom booking questions, each question is
            appended as an additional column (one per question, in the order
            assigned to the listing) with the attendee's selected answer text.
            For daily listings, the attendee list has a date filter &mdash;
            select a date to see only that day's attendees, and the CSV export
            respects the same filter.
          </p>
        </Q>

        <Q q={t("guide.q.reset_database")}>
          <p>
            It permanently deletes <strong>everything</strong>: all listings,
            attendees, groups, questions, users, holidays, API keys, activity
            logs, payment configuration, and sessions. The system returns to its
            initial setup state. You must type a confirmation phrase to proceed.
            This cannot be undone.
          </p>
        </Q>
      </Section>

      <Section id="webhooks" title={t("guide.sections.webhooks")}>
        <Q q={t("guide.q.what_are_webhooks")}>
          <p>
            Webhooks send an automatic notification to a URL of your choice
            whenever someone registers for a listing. You can use them to
            connect to other services, e.g. sending a Slack message or updating
            a spreadsheet.
          </p>
        </Q>

        <Q q={t("guide.q.setup_webhook")}>
          <p>
            Add a webhook URL when creating or editing a listing. Every time
            someone books that listing, a POST request is sent to your URL with
            the attendee's details.
          </p>
        </Q>

        <Q q={t("guide.q.webhook_json_format")}>
          <p>
            Each webhook is an HTTP POST with{" "}
            <code>Content-Type: application/json</code>. Here is an example
            payload for a paid listing booking:
          </p>
          <pre>
            <code>{WEBHOOK_EXAMPLE_JSON}</code>
          </pre>
          <p>
            Prices are in the smallest currency unit (e.g. pence for GBP, cents
            for USD). The <code>ticket_url</code> links to the attendee's ticket
            page. For multi-listing bookings the <code>tickets</code> array
            contains one entry per listing, all sharing the same ticket token.
          </p>
        </Q>
      </Section>

      <Section id="login" title="Login &amp; Sessions">
        <Q q="What are sessions?">
          <p>
            A session is created each time an admin logs in. Sessions expire
            after 24 hours. You can view all active sessions from the{" "}
            <strong>Sessions</strong> page.
          </p>
        </Q>

        <Q q="What happens when I change my password?">
          <p>
            Changing your password <strong>ends every active session</strong>{" "}
            for your account &mdash; you and anyone else signed in as you will
            be logged out and must sign in again with the new password.
          </p>
          <p>
            Your existing attendee data remains fully accessible. The encryption
            key is re-secured with the new password, so every record created
            before the change can still be decrypted after you log back in.
          </p>
        </Q>

        <Q q="How do I log out other users?">
          <p>
            On the <strong>Sessions</strong> page, click "Log out of all other
            sessions". This ends every session except your own, forcing all
            other admins to log in again. Useful if you suspect an account has
            been compromised.
          </p>
        </Q>

        <Q q="What happens after too many failed login attempts?">
          <p>
            The login form is protected by per-IP rate limiting. After{" "}
            <strong>{MAX_LOGIN_ATTEMPTS} failed attempts</strong> from the same
            IP address, further login attempts from that IP are blocked for{" "}
            <strong>{LOGIN_LOCKOUT_MS / 60_000} minutes</strong>. A successful
            login clears the counter immediately. This defends against password
            guessing and credential stuffing.
          </p>
          <p>
            If you&apos;re legitimately locked out, wait for the lockout to
            expire or log in from a different network. Because there is{" "}
            <strong>no password recovery</strong> (see{" "}
            <strong>Data &amp; Privacy</strong>), another owner cannot unlock
            your account &mdash; only time (or switching IP) will clear the
            block.
          </p>
        </Q>
      </Section>

      <Section id="calendar" title={t("guide.sections.calendar")}>
        <Q q={t("guide.q.what_is_calendar")}>
          <p>
            The <strong>Calendar</strong> page lets you pick a date and see
            every attendee booked across all listings on that day. This is
            especially useful for daily listings. You can export a CSV of the
            day's attendees and manage check-ins, edits, and deletions from the
            same view.
          </p>
        </Q>
      </Section>

      <Section id="activity-log" title={t("guide.sections.activity_log")}>
        <Q q={t("guide.q.what_is_activity_log")}>
          <p>
            The <strong>Log</strong> page shows a chronological list of admin
            actions such as listing creation, listing updates, attendee changes,
            and question changes. Both owners and managers can view the log.
            Each listing also has its own log, accessible from the listing page,
            showing only actions related to that listing.
          </p>
        </Q>
      </Section>

      <Section id="email" title={t("guide.sections.email_notifications")}>
        <Q q={t("guide.q.what_are_email_notifications")}>
          <p>
            When configured, the system can send up to two emails after each
            successful registration: a <strong>confirmation email</strong> to
            the attendee (if they provided an email address) with their ticket
            details and link, and a <strong>notification email</strong> to the
            business email address (if one is set) letting you know someone has
            booked. Emails are sent in the background and won't delay the
            booking process.
          </p>
        </Q>

        <Q q={t("guide.q.supported_email_providers")}>
          <p>
            Five providers are supported, all using HTTP APIs (no SMTP
            required):
          </p>
          <ul>
            <li>
              <strong>Resend</strong>
            </li>
            <li>
              <strong>Postmark</strong>
            </li>
            <li>
              <strong>SendGrid</strong>
            </li>
            <li>
              <strong>Mailgun (US)</strong>
            </li>
            <li>
              <strong>Mailgun (EU)</strong>
            </li>
          </ul>
          <p>
            All providers work the same way &mdash; choose whichever you already
            have an account with or whichever offers a free tier that suits your
            volume.
          </p>
        </Q>

        <Q q={t("guide.q.setup_email")}>
          {hostConfig?.hostEmailProvider && (
            <p>
              Email is already configured by your server administrator using{" "}
              <strong>{hostConfig.hostEmailProvider}</strong> with from address{" "}
              <code>{hostConfig.hostEmailFromAddress}</code>. You can override
              this by entering your own provider and API key in{" "}
              <a href="/admin/settings">Settings</a>. If you provide your own
              settings, they take priority over the server configuration.
            </p>
          )}
          <ol>
            <li>
              Go to <a href="/admin/settings">Settings</a> and find the{" "}
              <strong>Email</strong> section
            </li>
            <li>Choose your email provider from the dropdown</li>
            <li>
              Paste your provider's API key into the <strong>API Key</strong>{" "}
              field
            </li>
            <li>
              Enter a <strong>From Address</strong> &mdash; this is the sender
              address that appears on outgoing emails. If left blank, the
              business email address is used instead
            </li>
            <li>Save the settings</li>
          </ol>
          <p>
            The from address must be a verified sender in your email provider's
            account, otherwise emails will be rejected. Check your provider's
            documentation for how to verify a sender domain or address.
          </p>
        </Q>

        <Q q={t("guide.q.test_email_working")}>
          <p>
            After saving your email settings, a <strong>Send Test Email</strong>{" "}
            button appears. Click it to send a test email to your business email
            address. If the test fails, you'll see an error with the HTTP status
            code from your provider &mdash; check that your API key is correct
            and your from address is verified.
          </p>
        </Q>

        <Q q={t("guide.q.email_not_configured")}>
          <p>
            Email is entirely optional. If no provider is selected, the system
            skips sending emails silently. Registrations, payments, webhooks,
            and everything else continue to work normally.
          </p>
        </Q>

        <Q q={t("guide.q.confirmation_email_content")}>
          <p>
            The attendee receives an email with the listing name(s), quantity,
            price paid, and a clickable link to their ticket page. Each email
            also includes an SVG ticket image as an attachment &mdash; one per
            listing, with a QR code for check-in. For{" "}
            <strong>Purchase Only</strong> listings the QR code is omitted since
            there is no check-in. For multi-listing bookings, all listings are
            listed in a single email with numbered ticket attachments. The
            business email is set as the reply-to address so attendees can reply
            directly to you.
          </p>
        </Q>

        <Q q={t("guide.q.admin_notification_email_content")}>
          <p>
            You receive an email showing the attendee's name, email, phone,
            address, and any special instructions, along with the listing
            name(s), quantity, and price. The attendee's email is set as the
            reply-to address so you can reply directly to them.
          </p>
        </Q>
      </Section>

      <Section id="email-templates" title={t("guide.sections.email_templates")}>
        <Q q={t("guide.q.customise_emails")}>
          <p>
            Yes. In <a href="/admin/settings">Settings</a>, scroll to the email
            template sections. You can customise both the{" "}
            <strong>confirmation email</strong> (sent to the attendee) and the{" "}
            <strong>admin notification email</strong> (sent to you). Each has
            three parts: subject line, HTML body, and plain text body.
          </p>
          <p>
            Templates use <a href="https://liquidjs.com/">Liquid</a> syntax.
            Clear any field to revert to the built-in default.
          </p>
        </Q>

        <Q q={t("guide.q.template_variables")}>
          <ul>
            <li>
              <code>{"{{ listing_names }}"}</code> &mdash; all listing names
              joined with &ldquo;and&rdquo;
            </li>
            <li>
              <code>{"{{ ticket_url }}"}</code> &mdash; link to view tickets
            </li>
            <li>
              <code>{"{{ currency }}"}</code> &mdash; currency code (e.g. GBP)
            </li>
            <li>
              <code>{"{{ attendee.name }}"}</code>,{" "}
              <code>{"{{ attendee.email }}"}</code>,{" "}
              <code>{"{{ attendee.phone }}"}</code>,{" "}
              <code>{"{{ attendee.address }}"}</code>,{" "}
              <code>{"{{ attendee.special_instructions }}"}</code>
            </li>
            <li>
              <code>{"{{ attendee.quantity }}"}</code>,{" "}
              <code>{"{{ attendee.price_paid }}"}</code>,{" "}
              <code>{"{{ attendee.date }}"}</code>
            </li>
          </ul>
          <p>
            For multi-listing bookings, loop through the <code>entries</code>{" "}
            array: <code>{"{% for entry in entries %}"}</code>. Each entry has{" "}
            <code>entry.listing.name</code>,{" "}
            <code>entry.attendee.quantity</code>,{" "}
            <code>entry.attendee.date</code>, etc. The quantity and date are
            per-listing &mdash; each entry shows the values for that specific
            listing registration.
          </p>
        </Q>

        <Q q={t("guide.q.template_filters")}>
          <p>Two custom filters are built in:</p>
          <ul>
            <li>
              <code>{"{{ amount | currency }}"}</code> &mdash; formats a number
              as currency (e.g. &pound;15.00)
            </li>
            <li>
              <code>{'{{ count | pluralize: "ticket", "tickets" }}'}</code>{" "}
              &mdash; returns the singular or plural form based on the count
            </li>
          </ul>
        </Q>

        <Q q={t("guide.q.template_error")}>
          <p>
            If a custom template fails to render, the system falls back to the
            built-in default template automatically. The email is still sent
            &mdash; your attendees won't miss their confirmation.
          </p>
        </Q>
      </Section>

      <Section id="bulk-email" title="Bulk Email">
        <Q q="How do I email a group of attendees?">
          <p>
            Open <strong>Emails</strong> in the top navigation (owners only), or
            click <strong>Email Attendees</strong> on a listing page to message
            that listing's attendees. Choose who receives it, write your message
            in Markdown, tick <strong>marketing</strong> if it's promotional,
            then click <strong>Preview</strong>. The preview shows the rendered
            email, the exact recipient count, and what kind of message it is
            before you send.
          </p>
        </Q>

        <Q q="Who can I send to?">
          <p>
            From a listing page, the recipients are that listing's attendees.
            From the <strong>Emails</strong> page you pick an audience:
          </p>
          <ul>
            <li>
              <strong>Active listing attendees</strong> &mdash; everyone booked
              onto a currently-active listing (the default).
            </li>
            <li>
              <strong>Upcoming listing attendees</strong> &mdash; everyone
              booked onto an active listing that hasn't happened yet.
            </li>
            <li>
              <strong>All attendees</strong> &mdash; everyone who has ever
              registered.
            </li>
          </ul>
          <p>
            In every case, only attendees who gave an email address are
            included, and duplicate addresses are removed automatically.
          </p>
        </Q>

        <Q q="Why do I need my own email provider to send?">
          <p>
            Bulk email sends through <strong>your own</strong> configured email
            provider, not any shared/host email. Sending marketing from a shared
            address would put every site on the platform at risk of being
            flagged as spam. If you haven't added your own provider (under{" "}
            <a href="/admin/settings-advanced">Advanced Settings</a> &rarr;{" "}
            <strong>Email Notifications</strong>), the Send button is disabled
            &mdash; but you can still use the BCC email-app option (see below).
          </p>
          <p>
            Bulk email goes out through your provider's batch API, so all
            supported providers (Resend, Postmark, SendGrid, and Mailgun) can
            send it.
          </p>
        </Q>

        <Q q="What's the difference between a marketing and a transactional email?">
          <p>
            A <strong>transactional</strong> (service) email is essential
            information about a listing someone booked &mdash; a venue change, a
            reminder, cancellation details. A <strong>marketing</strong> email
            promotes something &mdash; a new listing, an offer, a newsletter.
          </p>
          <p>
            When you tick <strong>marketing</strong>, every email gets an{" "}
            <strong>unsubscribe footer</strong>, and anyone who has previously
            unsubscribed is skipped automatically. Transactional emails get no
            footer and reach everyone. Only mark genuine promotions as marketing
            &mdash; mislabelling promotions as transactional to dodge the
            unsubscribe rules can breach anti-spam laws (such as GDPR/PECR or
            CAN-SPAM).
          </p>
        </Q>

        <Q q="How does unsubscribing work?">
          <p>
            Every marketing email includes an unsubscribe link. It opens a page
            where the recipient can unsubscribe (or resubscribe) with a single
            click &mdash; no login needed. The link identifies them by a one-way
            hash of their address, so the page never reveals or exposes the
            email address itself, and the action only happens on a button press,
            never just by opening the link.
          </p>
          <p>
            Unsubscribes apply to <strong>marketing</strong> emails only.
            Transactional/service messages about a booking still reach everyone.
          </p>
        </Q>

        <Q q="What is the BCC email-app option?">
          <p>
            On the preview page there's always an option to open the email in
            your own mail app with the subject and body pre-filled. When it's
            going to several people they all go in <strong>BCC</strong> (with
            the draft addressed from your business email) so they can't see each
            other; a single recipient is simply addressed directly. It needs no
            provider setup, so it works even when system sending is disabled.
            Use it sparingly though &mdash; sending lots of mail this way,
            especially marketing, is a quick way to get your personal email
            account rate-limited or blocked. It's best for small, genuinely
            transactional messages.
          </p>
        </Q>

        <Q q="Can I see how often I've contacted someone?">
          <p>
            Yes. Each attendee's page shows an <strong>Email History</strong>{" "}
            &mdash; how many bulk emails they've received, when they were last
            contacted, and the last subject &mdash; so you can avoid
            over-emailing. When you preview a bulk email, a line summarises how
            often that audience has been contacted on average, so you get a
            sense of the group before you send.
          </p>
          <p>
            Counts cover bulk emails only (not per-booking confirmations) and
            are tracked against a one-way hash of the address, so the history
            follows the person even across separate bookings.
          </p>
        </Q>
      </Section>

      <Section id="host-subdomain" title="Host Subdomain">
        <Q q="What is a host subdomain?">
          <p>
            If your server administrator has enabled subdomain registration, you
            can claim a pretty subdomain for your tickets site (e.g.{" "}
            <code>
              my-business
              {hostConfig?.bunnyDnsSubdomainSuffix || ".example.com"}
            </code>
            ) instead of using the default CDN hostname. The option appears in{" "}
            <strong>Advanced Settings</strong> under{" "}
            <strong>Host Subdomain</strong>.
          </p>
        </Q>

        <Q q="How do I register a subdomain?">
          <ol>
            <li>
              Go to <a href="/admin/settings-advanced">Advanced Settings</a> and
              find the <strong>Host Subdomain</strong> section
            </li>
            <li>
              Enter your preferred subdomain name (lowercase letters, numbers,
              and hyphens only)
            </li>
            <li>
              Click{" "}
              <strong>Check Availability &amp; Preview Complete Domain</strong>{" "}
              to see the full URL and verify it's available
            </li>
            <li>
              If it looks right, tick the confirmation checkbox and click{" "}
              <strong>Register Subdomain</strong>
            </li>
          </ol>
          <p>
            <strong>Important:</strong> Once registered, a subdomain is{" "}
            <strong>permanent and cannot be changed</strong>. DNS, SSL, and CDN
            configuration are handled automatically.
          </p>
        </Q>

        <Q q="Can I use both a subdomain and a custom domain?">
          <p>
            Yes. Your host subdomain and custom domain can be active at the same
            time. Attendees can reach your site through either address.
          </p>
        </Q>
      </Section>

      <Section id="custom-domain" title={t("guide.sections.custom_domain")}>
        <Q q={t("guide.q.setup_custom_domain")}>
          <p>
            If your site runs on Bunny CDN and the <code>BUNNY_API_KEY</code>{" "}
            and <code>BUNNY_SCRIPT_ID</code> environment variables are
            configured, you'll see a <strong>Custom Domain</strong> section in{" "}
            <a href="/admin/settings-advanced">Advanced Settings</a>. Enter your
            domain (e.g. <code>tickets.yourdomain.com</code>) and save, then
            follow the CNAME instructions shown and click{" "}
            <strong>Validate</strong>.
          </p>
        </Q>

        <Q q={t("guide.q.what_does_validation_do")}>
          <p>
            Validation registers the hostname with the Bunny CDN pull zone,
            requests a free SSL certificate, and enables HTTPS. You can
            re-validate at any time if you change your DNS.
          </p>
        </Q>

        <Q q="What if validation fails?">
          <p>
            Validation is attempted automatically when you save your domain. If
            it fails &mdash; usually because DNS hasn't propagated yet &mdash;
            your domain is still saved and you'll see a warning. Create the
            CNAME record shown on the page, wait a few minutes for DNS to
            propagate, then click <strong>Validate Custom Domain</strong> to try
            again.
          </p>
          <p>
            Until validation succeeds, ticket links, redirect URLs, and emails
            continue to use your host subdomain (or the Bunny.net address if you
            haven't registered one). See{" "}
            <strong>Which domain is used for ticket links and emails?</strong>{" "}
            below.
          </p>
        </Q>

        <Q q="Which domain is used for ticket links and emails?">
          <p>
            The system picks a single <strong>canonical</strong> domain for
            every request and uses it for generated URLs (ticket links, QR
            codes, redirects, webhook callbacks, and emails). It's chosen in
            this order of priority:
          </p>
          <ol>
            <li>
              Your <strong>custom domain</strong>, but only once its{" "}
              <strong>CNAME has been validated</strong>. Saving a domain is not
              enough on its own.
            </li>
            <li>
              Your registered <strong>host subdomain</strong> (e.g.{" "}
              <code>mysite.tickets</code>), if one is set.
            </li>
            <li>
              Otherwise the hostname from the incoming request (the Bunny.net
              address).
            </li>
          </ol>
          <p>
            Both the host subdomain and a validated custom domain continue to
            accept traffic at the CDN level, but only the higher-priority one is
            used when the system generates links.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.settings_overview")}>
        <Q q={t("guide.q.available_settings")}>
          <p>
            The <strong>Settings</strong> page (owners only) lets you configure:
          </p>
          <ul>
            <li>
              <strong>Country</strong> &mdash; sets your timezone, currency, and
              phone prefix in one step
            </li>
            <li>
              <strong>Business email</strong> &mdash; receives admin
              notification emails, used as reply-to on attendee confirmations,
              and included in webhook payloads
            </li>
            <li>
              <strong>Payment provider</strong> &mdash; Stripe, Square, SumUp,
              or none
            </li>
            <li>
              <strong>Booking fee</strong> &mdash; percentage-based fee added to
              ticket prices (requires a payment provider)
            </li>
            <li>
              <strong>Header image</strong> &mdash; upload a logo or banner
              shown at the top of every page
            </li>
            <li>
              <strong>Embed hosts</strong> &mdash; restrict which websites can
              embed your booking forms
            </li>
            <li>
              <strong>Terms and conditions</strong> &mdash; attendees must agree
              before booking
            </li>
            <li>
              <strong>Show public site</strong> &mdash; enable or disable the
              public-facing website
            </li>
            <li>
              <strong>Site theme</strong> &mdash; light or dark
            </li>
            <li>
              <strong>Admin password</strong> &mdash; change your login password
            </li>
          </ul>
        </Q>

        <Q q="How does the header image work?">
          <p>
            Upload a logo or banner from <strong>Settings</strong> and it
            appears at the top of every admin and public page. The image is
            encrypted and served through the <code>/image/</code> proxy with
            long-lived immutable cache headers, so browsers only download it
            once.
          </p>
          <p>
            Supported formats are JPEG, PNG, GIF, and WebP, up to 256&nbsp;KB.
            Uploading a new image automatically deletes the old one, and the{" "}
            <strong>Remove Image</strong> button clears it completely. If image
            storage isn't configured the section is hidden &mdash; see{" "}
            <strong>Advanced Settings</strong> to set up a Bunny storage zone.
          </p>
        </Q>

        <Q q={t("guide.q.advanced_settings")}>
          <p>
            The main Settings page has a link to{" "}
            <strong>Advanced Settings</strong> for less common configuration.
            Advanced settings include:
          </p>
          <ul>
            <li>
              <strong>Public API</strong> &mdash; enable the JSON API for
              external integrations
            </li>
            <li>
              <strong>Apple Wallet</strong> &mdash; configure pass signing
              certificates for Add to Apple Wallet
            </li>
            <li>
              <strong>Google Wallet</strong> &mdash; configure service account
              credentials for Add to Google Wallet
            </li>
            <li>
              <strong>Email provider</strong> &mdash; choose and configure your
              email sending service
            </li>
            <li>
              <strong>Email templates</strong> &mdash; customise confirmation
              and admin notification emails using Liquid syntax
            </li>
            <li>
              <strong>Host subdomain</strong> &mdash; register a pretty
              subdomain for your site (when enabled by server administrator)
            </li>
            <li>
              <strong>Custom domain</strong> &mdash; set up a custom domain for
              your site (Bunny CDN only)
            </li>
            <li>
              <strong>Backups</strong> &mdash; create, download, and restore
              full database backups (requires CDN storage)
            </li>
            <li>
              <strong>Software updates</strong> &mdash; check for and install
              new versions
            </li>
            <li>
              <strong>Database reset</strong> &mdash; permanently delete all
              data
            </li>
          </ul>
        </Q>

        <Q q={t("guide.q.what_is_debug_page")}>
          <p>
            The debug page at <code>/admin/debug</code> shows the configuration
            status of all integrated services (payments, email, Apple Wallet,
            Google Wallet, storage, CDN, notifications, database) without
            revealing any secrets or API keys. It's useful for troubleshooting
            setup issues &mdash; you can quickly see which services are
            configured and which are missing.
          </p>
          <p>
            The page also lists every tunable system limit (file-size caps,
            session and URL expiry windows, login lockout, database pruning
            retention) alongside its default and current value. Any limit can be
            overridden by setting the matching environment variable to a
            positive integer; overridden values are highlighted. A
            &quot;Database pruning&quot; table at the bottom shows when each
            short-lived table was last cleaned up.
          </p>
        </Q>

        <Q q="What is the debug footer?">
          <p>
            The debug footer appears at the bottom of every admin page you view
            while signed in. It reports how long the page took to render and
            summarises the database work done for that request: the total number
            of SQL queries, the time they consumed, and how many of them were
            served from the in-memory query cache.
          </p>
          <p>
            Click the summary line to expand it. The details panel lists every
            SQL statement that ran to build the page (with its execution time)
            and, where relevant, the current cache contents. The footer is only
            injected into authenticated admin page loads &mdash; it never
            appears on the public site, on form submissions, or on file
            downloads such as CSV exports, and signed-out visitors never see it.
          </p>
          <p>
            Use it to spot slow pages or unexpectedly large numbers of queries
            without leaving the page you're debugging.
          </p>
        </Q>
      </Section>

      {hostConfig?.builderEnabled && (
        <Section id="built-sites" title="Built Sites">
          <Q q="What are built sites?">
            <p>
              The <strong>Built Sites</strong> page (owners only) keeps a
              registry of Tickets instances you've deployed. Each entry records
              the site name and its Bunny CDN URL. You can add, edit, and delete
              entries to keep track of all the instances you manage.
            </p>
          </Q>

          <Q q="How do I create a new Tickets instance?">
            <p>
              Visit <code>/admin/builder</code> to deploy a new instance. Enter
              a site name, database URL (libsql format), and database token. The
              builder will fetch the latest release code from GitHub, create a
              Bunny edge script, configure secrets (including a generated
              encryption key), test the database connection, and publish the
              site. Host-level configuration such as email, wallet, and storage
              settings are copied automatically.
            </p>
          </Q>

          <Q q="What do I need before building a site?">
            <p>
              You need a libsql database (e.g. from{" "}
              <a href="https://turso.tech">Turso</a>) with its URL and auth
              token. The server must have <code>BUNNY_API_KEY</code> configured.
              The builder is owner-only.
            </p>
          </Q>

          <Q q="Can I add a site record without using the builder?">
            <p>
              Yes. On the <strong>Built Sites</strong> page, click{" "}
              <strong>Add Built Site</strong> to manually record a site name and
              URL. This is useful for tracking instances you deployed by other
              means.
            </p>
          </Q>
        </Section>
      )}

      <Section title={t("guide.sections.feeds_and_mobilizon")}>
        <Q q={t("guide.q.listing_feeds")}>
          <p>
            When the public site is enabled, two machine-readable feeds are
            available:
          </p>
          <ul>
            <li>
              <strong>ICS calendar</strong> &mdash;{" "}
              <code>/feeds/listings.ics</code> &mdash; subscribe from any
              calendar app (Google Calendar, Apple Calendar, Thunderbird, etc.)
            </li>
            <li>
              <strong>RSS feed</strong> &mdash; <code>/feeds/listings.rss</code>{" "}
              &mdash; subscribe from any RSS reader
            </li>
          </ul>
          <p>
            Both feeds include all active, non-hidden listings with open
            registration. Hidden listings are excluded. They update
            automatically as you add, change, or close listings.
          </p>
        </Q>

        <Q q={t("guide.q.connect_to_mobilizon")}>
          <p>
            <a href="https://mobilizon.org/">Mobilizon</a> is a federated events
            platform. You can use its built-in importer to pull listings from
            your ICS feed:
          </p>
          <ol>
            <li>
              On your Mobilizon instance, go to the event import tool (or use
              the public importer at{" "}
              <a href="https://import.mobilizon.fr/">import.mobilizon.fr</a>)
            </li>
            <li>
              Enter your ICS feed URL:{" "}
              <code>https://{getEffectiveDomain()}/feeds/listings.ics</code>
            </li>
            <li>
              Set <strong>joinMode</strong> to <strong>external</strong> so the
              &ldquo;Join&rdquo; button on Mobilizon links back to your
              registration page
            </li>
          </ol>
          <p>
            Listings will appear on Mobilizon and federate across the Fediverse.
            Users click through to your site to register and pay.
          </p>
        </Q>
      </Section>

      <Section id="api" title={t("guide.sections.public_api")}>
        <Q q={t("guide.q.what_is_public_api")}>
          <p>
            The system includes a JSON API that exposes the same data and
            booking functionality as the web interface. It lets you build custom
            frontends, integrate with other services, or automate bookings. The
            public endpoints below need no authentication. There is also an
            admin API for managing listings, groups, and holidays &mdash; see
            the <a href="#admin-api">Admin API</a> section below for details.
          </p>
        </Q>

        <Q q={t("guide.q.available_endpoints")}>
          <p>
            The base URL is your domain (e.g.{" "}
            <code>https://{getEffectiveDomain()}</code>). All responses are
            JSON.
          </p>
          <ul>
            <li>
              <code>GET /api/listings</code> &mdash; list all active, non-hidden
              listings
            </li>
            <li>
              <code>GET /api/listings/:slug</code> &mdash; get a single listing
              by its slug (hidden listings are accessible if you know the slug)
            </li>
            <li>
              <code>
                GET
                /api/listings/:slug/availability?quantity=N&amp;date=YYYY-MM-DD
              </code>{" "}
              &mdash; check if spots are available
            </li>
            <li>
              <code>POST /api/listings/:slug/book</code> &mdash; create a
              booking
            </li>
          </ul>
          <p>
            All endpoints support CORS, so you can call them from any website.
            <code>OPTIONS</code> preflight requests are handled automatically.
          </p>
        </Q>

        <Q q={t("guide.q.list_listings_api")}>
          <pre>
            <code>{`GET /api/listings\n\nResponse:\n${API_LIST_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            Prices are in the smallest currency unit (e.g. pence for GBP, cents
            for USD). <code>maxPurchasable</code> is 0 when the listing is sold
            out or registration is closed.
          </p>
        </Q>

        <Q q={t("guide.q.get_single_listing_api")}>
          <pre>
            <code>{`GET /api/listings/summer-workshop\n\nResponse:\n${API_SINGLE_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            The <code>availableDates</code> field is only included for daily
            listings. Returns <code>{'{ "error": "Listing not found" }'}</code>{" "}
            with status 404 if the listing doesn&apos;t exist or is inactive.
          </p>
        </Q>

        <Q q={t("guide.q.check_availability_api")}>
          <pre>
            <code>{`GET /api/listings/summer-workshop/availability?quantity=2\n\nResponse:\n${API_AVAILABILITY_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            For daily listings, add <code>&amp;date=YYYY-MM-DD</code> to check a
            specific date. The <code>quantity</code> parameter defaults to 1.
          </p>
        </Q>

        <Q q={t("guide.q.create_booking_api")}>
          <pre>
            <code>{`POST /api/listings/summer-workshop/book\nContent-Type: application/json\n\n${API_BOOK_REQUEST_JSON}`}</code>
          </pre>
          <p>
            Which fields are required depends on the listing's field settings.
            The <code>name</code> field is always required. <code>date</code> is
            required for daily listings (use a date from{" "}
            <code>availableDates</code>). <code>customPrice</code> is for
            pay-more listings only (in major currency units, e.g. 10.00 for
            &pound;10).
          </p>
          <p>
            <strong>Free listing response:</strong>
          </p>
          <pre>
            <code>{API_BOOK_FREE_EXAMPLE_JSON}</code>
          </pre>
          <p>
            <strong>Paid listing response:</strong>
          </p>
          <pre>
            <code>{API_BOOK_PAID_EXAMPLE_JSON}</code>
          </pre>
          <p>
            Redirect the user to <code>checkoutUrl</code> to complete payment.
            Possible error responses: 400 (validation error or registration
            closed), 404 (listing not found), 409 (not enough spots available).
          </p>
        </Q>

        <Q q={t("guide.q.api_data_exposure")}>
          <p>
            The API exposes <strong>exactly the same data</strong> as the public
            booking pages &mdash; no more. Internal fields like capacity limits,
            attendee counts, close times, and webhook URLs are never included.
            The <code>isSoldOut</code>, <code>isClosed</code>, and{" "}
            <code>maxPurchasable</code> fields are derived values, not raw
            database fields.
          </p>
        </Q>

        <Q q="Where can I find the full API reference?">
          <p>
            The <a href="/admin/api-keys/docs">API documentation page</a> has a
            complete reference for both public and admin API endpoints, with
            example request and response payloads for each.
          </p>
        </Q>
      </Section>

      <Section id="admin-api" title="Admin API">
        <Q q="What is the admin API?">
          <p>
            The admin API exposes the same management operations as the web
            admin area as JSON endpoints. Use it to script bulk changes, build
            internal tooling, or sync listings from another system. Unlike the
            public API, it requires authentication with an API key and is
            available to <strong>owners only</strong>.
          </p>
        </Q>

        <Q q="How do I create an API key?">
          <p>
            Open <a href="/admin/api-keys">API Keys</a> (under{" "}
            <strong>Users</strong> in the navigation), enter a descriptive name
            for the key (e.g. "CI pipeline" or "Zapier integration"), and click{" "}
            <strong>Create key</strong>.
          </p>
          <p>
            <strong>The full key is shown only once.</strong> Copy it
            immediately and store it somewhere secure &mdash; once you leave the
            page there is no way to retrieve it again. If you lose a key, delete
            it and create a new one.
          </p>
        </Q>

        <Q q="How do I authenticate?">
          <p>
            Send the key in the <code>Authorization</code> header on every
            request:
          </p>
          <pre>
            <code>Authorization: Bearer YOUR_API_KEY</code>
          </pre>
          <p>
            Bearer-authenticated requests do not need a CSRF token. Send JSON
            request bodies with <code>Content-Type: application/json</code>.
            Requests without a valid key receive a{" "}
            <code>401 Invalid API key</code> response.
          </p>
        </Q>

        <Q q="What admin endpoints are available?">
          <p>
            The admin API covers listings, groups, and holidays. Each resource
            supports list, get, create, update, and delete:
          </p>
          <ul>
            <li>
              <code>GET /api/admin/listings</code>,{" "}
              <code>POST /api/admin/listings</code>,{" "}
              <code>GET /api/admin/listings/:id</code>,{" "}
              <code>PUT /api/admin/listings/:id</code>,{" "}
              <code>DELETE /api/admin/listings/:id</code>,{" "}
              <code>POST /api/admin/listings/:id/deactivate</code>,{" "}
              <code>POST /api/admin/listings/:id/reactivate</code>
            </li>
            <li>
              <code>GET /api/admin/groups</code>,{" "}
              <code>POST /api/admin/groups</code>,{" "}
              <code>GET /api/admin/groups/:id</code>,{" "}
              <code>PUT /api/admin/groups/:id</code>,{" "}
              <code>DELETE /api/admin/groups/:id</code>
            </li>
            <li>
              <code>GET /api/admin/holidays</code>,{" "}
              <code>POST /api/admin/holidays</code>,{" "}
              <code>GET /api/admin/holidays/:id</code>,{" "}
              <code>PUT /api/admin/holidays/:id</code>,{" "}
              <code>DELETE /api/admin/holidays/:id</code>
            </li>
          </ul>
          <p>
            Delete requests must include a <code>confirm_identifier</code> field
            that matches the resource name &mdash; the same way the web UI
            requires you to type the name to confirm a delete. The{" "}
            <a href="/admin/api-keys/docs">API documentation page</a> shows the
            full request and response shape for every endpoint.
          </p>
        </Q>

        <Q q="How do I revoke an API key?">
          <p>
            Open <a href="/admin/api-keys">API Keys</a>, find the key in the
            list, and click <strong>Delete</strong>. You'll be asked to type the
            key's name to confirm. Revocation is immediate &mdash; any
            integration using that key will start receiving{" "}
            <code>401 Invalid API key</code> on its next request, so switch
            integrations over to a new key before deleting the old one.
          </p>
          <p>
            The <strong>Last used</strong> column on the API Keys page shows
            when each key was most recently accepted. Use it to spot keys that
            are no longer in use before deleting them.
          </p>
        </Q>

        <Q q="What happens to API keys if their owner is deleted?">
          <p>
            Each API key is tied to the owner who created it, because the key
            wraps that owner's data encryption key. When you delete an owner
            from the <strong>Users</strong> page, all of their API keys are
            deleted at the same time and any integration using one of those keys
            will stop working immediately. If a previous owner had keys in use,
            create new keys under another owner before removing the old account.
          </p>
        </Q>
      </Section>

      <Section id="backups" title="Backups">
        <Q q="What is the backup feature?">
          <p>
            The <strong>Backups</strong> page (owners only, under{" "}
            <a href="/admin/backup">Settings &rarr; Backups</a>) lets you create
            and restore full database backups. Each backup is a .zip archive
            containing SQL statements for every table. Backups are stored on
            your configured CDN storage (Bunny CDN).
          </p>
        </Q>

        <Q q="How do I create a backup?">
          <p>
            Go to <a href="/admin/backup">Backups</a> and click{" "}
            <strong>Create Backup Now</strong>. The system exports all database
            tables into a .zip file and uploads it to your storage. Previous
            backups are listed with their timestamps and can be downloaded at
            any time.
          </p>
        </Q>

        <Q q="How do I restore from a backup?">
          <p>
            On the Backups page, upload a .zip backup file using the restore
            form. You'll see a summary of how many SQL statements it contains
            and whether the schema version matches. Type the full confirmation
            phrase to proceed. <strong>Warning:</strong> restoring drops all
            existing tables and replaces them with the backup contents. This
            cannot be undone.
          </p>
        </Q>

        <Q q="Are old backups deleted automatically?">
          <p>
            Yes. Only the most recent backups are kept (30 by default,
            configurable via <code>MAX_BACKUPS</code>). When a new backup is
            created beyond that limit, the oldest is purged automatically. The
            Backups page shows how many you have and when the oldest will be
            removed. Automatic pre-migration backups count towards this limit
            too.
          </p>
        </Q>

        <Q q="What is the encryption key shown on the backup page?">
          <p>
            The encryption key is needed if you ever restore a backup to a{" "}
            <strong>different</strong> site. All personal data in the database
            is encrypted at the field level, so you need the same encryption key
            to read it. Store this key securely &mdash; it cannot be recovered
            if lost.
          </p>
        </Q>

        <Q q="Do backups require any special configuration?">
          <p>
            Yes. Backups require CDN storage to be configured (
            <code>STORAGE_ZONE_NAME</code> and <code>STORAGE_ZONE_KEY</code>).
            The feature is designed for remote databases (<code>libsql://</code>
            ). If storage is not configured, the backup page will show a message
            explaining this.
          </p>
        </Q>
      </Section>

      <Section id="read-only-mode" title="Read-only Mode">
        <Q q="Why does my site say it's in read-only mode?">
          <p>
            Read-only mode is switched on by the host (not from inside the
            admin) and is used for two things: sites that have fallen behind on
            billing, and sites undergoing maintenance. While it's on, bookings
            are refused and the create/edit pages for listings and groups are
            blocked, but everything else stays viewable. If you think your site
            shouldn't be in read-only mode, get in touch with whoever hosts it
            for you.
          </p>
        </Q>
      </Section>

      <Section title="Software Updates">
        <Q q="How do I check for updates?">
          <p>
            Go to <code>/admin/update</code> to see your current build date and
            commit. Click <strong>Check for Updates</strong> to query GitHub for
            the latest release. If a newer version is available, you'll see its
            name and version number.
          </p>
        </Q>

        <Q q="What does the version number mean?">
          <p>
            Versions use the format <code>vYYYY-MM-DD-HHMMSS</code> &mdash; the
            UTC date and time the release was built, to the second. Larger
            timestamps are newer, and your installation compares its own build
            time against the latest release tag to decide whether an update is
            available. Because the tag is generated at build time and pushed as
            the git tag, the version on the update page always matches the
            release on GitHub.
          </p>
        </Q>

        <Q q="How do I install an update?">
          <p>
            If an update is available and your server has{" "}
            <code>BUNNY_API_KEY</code> and <code>BUNNY_SCRIPT_ID</code>{" "}
            configured, an <strong>Update Now</strong> button appears. Click it
            to download and deploy the new version automatically via Bunny CDN.
            The update is logged in the activity log. If the Bunny environment
            variables are not set, you'll need to deploy the update manually.
          </p>
        </Q>

        <Q q="Where can I read the release notes?">
          <p>
            The update page includes a link to the{" "}
            <a href="https://github.com/chobbledotcom/tickets/releases">
              release notes on GitHub
            </a>
            , where you can see what changed in each version before deciding to
            update.
          </p>
        </Q>
      </Section>

      <Section title={t("guide.sections.customising_your_site")}>
        <Q q={t("guide.q.customise_system")}>
          <p>
            Absolutely. This is open-source software, so you have full control.
            You can{" "}
            <a href="https://github.com/chobbledotcom/tickets">
              grab the code from GitHub
            </a>{" "}
            and host it yourself on Bunny Edge Scripting or any compatible
            platform. The README has deployment instructions to get you started.
          </p>
        </Q>

        <Q q={t("guide.q.customise_for_me")}>
          <p>
            Yes. I offer customisation at a transparent flat rate &mdash; see{" "}
            <a href="https://chobble.com/prices">chobble.com/prices</a> for
            current pricing. I can help you with custom features, branding,
            listing image design, hosting setup, or whatever you need. You'll
            own the code outright, and I can show you how to maintain it
            yourself or handle updates for you. Over 20 years building web
            systems means I can usually solve problems quickly and clearly.
          </p>
        </Q>

        <Q q={t("guide.q.hosting_and_images")}>
          <p>
            Yes to both. I can set you up on your own Bunny CDN account (or
            another host) and handle the technical configuration. I also design
            listing images if you need them. Get in touch and we'll figure out
            exactly what you need.
          </p>
        </Q>
      </Section>
      <Section id="column-order" title="Column Order">
        <Q q="How do I customise which columns appear in tables?">
          <p>
            Go to <strong>Advanced Settings</strong> and find the{" "}
            <strong>Listing Table Columns</strong> or{" "}
            <strong>Attendee Table Columns</strong> section. Enter a
            comma-separated list of Liquid-style tags to control which columns
            appear and in what order.
          </p>
          <p>
            For example, to show only the name and status on the listings table:
          </p>
          <pre>
            <code>{"{{name}}, {{status}}"}</code>
          </pre>
          <p>
            Leave the field empty or clear it to restore the default column
            order.
          </p>
        </Q>

        <Q q="What listing table columns are available?">
          <p>
            Default order:{" "}
            <code>{buildDefaultTemplate(LISTING_DEFAULT_ORDER)}</code>
          </p>
          <Raw html={columnReferenceTable(LISTING_TABLE_COLUMNS)} />
        </Q>

        <Q q="What attendee table columns are available?">
          <p>
            Default order:{" "}
            <code>{buildDefaultTemplate(ATTENDEE_DEFAULT_ORDER)}</code>
          </p>
          <p>
            Columns referencing absent data (e.g. <code>{"{{email}}"}</code>{" "}
            when no attendees have an email) are hidden automatically even when
            included in the template.
          </p>
          <Raw html={columnReferenceTable(ATTENDEE_TABLE_COLUMNS)} />
        </Q>

        <Q q="Can I use custom date or currency formatting?">
          <p>
            Yes. Date and price columns support Liquid filters. Add a pipe (
            <code>|</code>) after the column name followed by the filter:
          </p>
          <pre>
            <code>
              {'{{created | date: "%B %d, %Y"}}'}
              {"\n"}
              {'{{date | date: "%A %e %b"}}'}
              {"\n"}
              {"{{price | currency}}"}
            </code>
          </pre>
          <p>
            The <code>date</code> filter uses{" "}
            <a href="https://strftime.net/">strftime format codes</a>. Common
            codes:
          </p>
          <ul>
            <li>
              <code>%Y</code> full year, <code>%y</code> 2-digit year
            </li>
            <li>
              <code>%B</code> full month name, <code>%b</code> abbreviated
            </li>
            <li>
              <code>%d</code> zero-padded day, <code>%e</code> day without
              padding
            </li>
            <li>
              <code>%A</code> full weekday, <code>%a</code> abbreviated
            </li>
            <li>
              <code>%H</code> hour (24h), <code>%I</code> hour (12h),{" "}
              <code>%M</code> minutes
            </li>
          </ul>
          <p>
            The <code>currency</code> filter formats a number as your configured
            currency (e.g. <code>2500</code> &rarr; &pound;25.00).
          </p>
          <p>
            Columns without a <code>rawValue</code> (like name or email) ignore
            filters &mdash; they always render their default content.
          </p>
        </Q>
      </Section>
    </Layout>,
  );
