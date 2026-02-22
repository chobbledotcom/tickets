/**
 * Admin guide page template - FAQ-style help for administrators
 */

import type { Child } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

const Section = ({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children?: Child;
}): JSX.Element => (
  <>
    <h3 id={id}>{title}</h3>
    {children}
  </>
);

const Q = ({
  q,
  children,
}: {
  q: string;
  children?: Child;
}): JSX.Element => (
  <details>
    <summary>{q}</summary>
    {children}
  </details>
);

/**
 * Admin guide page
 */
export const adminGuidePage = (adminSession: AdminSession): string =>
  String(
    <Layout title="Guide">
      <AdminNav session={adminSession} />

      <h2>Guide</h2>

      <Section title="Getting Started">
        <Q q="How do I create an event?">
          <p>
            From the <strong>Events</strong> page, fill in the form at the
            bottom. Give your event a name, set the capacity, and choose which
            contact details to collect (any combination of email, phone,
            postal address, and special instructions). You can leave the price
            blank for free events.
            Once created, share the booking link with your attendees.
          </p>
        </Q>

        <Q q="How do I set up payments?">
          <p>
            Go to <strong>Settings</strong> and choose Stripe or Square as your
            payment provider. Paste in your API key and save. For Stripe, the
            webhook is configured automatically. For Square, you'll need to copy
            the webhook URL shown and add it in your Square Developer Dashboard.
          </p>
        </Q>
      </Section>

      <Section title="Events">
        <Q q="What's the difference between standard and daily events?">
          <p>
            A <strong>standard event</strong> is a one-off &mdash; attendees
            book a place and the capacity applies to the whole event. A{" "}
            <strong>daily event</strong> lets attendees pick a specific date when
            booking. The capacity limit applies separately to each date, so you
            can run the same event every day with a fresh allocation.
          </p>
        </Q>

        <Q q="How do I combine multiple events into one booking?">
          <p>
            Join event slugs with a <code>+</code> in the URL, e.g.{" "}
            <code>/ticket/event-one+event-two</code>. Attendees see a single
            form, fill in their details once, and book all selected events in
            one go. If any are paid, they complete one checkout for the total.
          </p>
          <p>
            To generate the link, open the <strong>Multi-booking link</strong>{" "}
            section on the <strong>Events</strong> page and tick the events you
            want to combine. The link updates as you select, and events appear
            in the order you tick them.
          </p>
        </Q>

        <Q q="What are groups?">
          <p>
            Groups let you bundle related events under a single URL. Create a
            group from the <strong>Groups</strong> page, then assign events to
            it using the group dropdown on the event form. Share{" "}
            <code>/ticket/your-group-slug</code> and attendees see all active
            events in the group on one page. If you add terms and conditions to
            a group, they replace the global T&amp;Cs for that page.
          </p>
        </Q>

        <Q q="What are the event date and location fields for?">
          <p>
            These are optional fields you can fill in when creating or editing
            an event. The date is when the event takes place (in your
            configured timezone) and the location is where it's held. Both are
            displayed on the attendee's
            ticket page so they know when and where to go. For daily events,
            attendees already pick a date when booking, so the event date field
            is more useful for standard (one-off) events.
          </p>
        </Q>

        <Q q="What does 'max tickets per purchase' do?">
          <p>
            It controls how many tickets one person can book in a single
            transaction. For example, setting it to 4 lets someone book up to 4
            places at once. The quantity dropdown on the booking form won't
            exceed this number or the remaining capacity, whichever is lower.
          </p>
        </Q>

        <Q q="How do registration deadlines work?">
          <p>
            Set a "closes at" date and time on your event. After that moment,
            the booking form shows a "registration closed" message and no
            further bookings are accepted. If someone loaded the form before the
            deadline but submits after, their booking is also rejected.
          </p>
        </Q>

        <Q q="How do I embed the booking form on my website?">
          <p>
            Use the <strong>Embed Script</strong> code from your event page
            (recommended) or the <strong>Embed Iframe</strong> code if you
            prefer the manual setup. In <strong>Settings</strong>, add your
            website's domain to the embed hosts list so the browser allows the
            iframe to load.
          </p>
        </Q>

        <Q q="How do I manually add an attendee?">
          <p>
            Open the event page and scroll down to <strong>Add Attendee</strong>.
            Fill in the name and contact details, set the quantity, and submit.
            The attendee is added directly without needing to go through the
            booking form or payment flow. Useful for walk-ins, comps, or manual
            corrections.
          </p>
        </Q>

        <Q q="How do I set a custom redirect after booking?">
          <p>
            When creating or editing an event, enter a URL in the "thank you
            URL" field. After a successful booking or payment, attendees are
            redirected to that address instead of seeing the default confirmation
            page. The URL must use HTTPS.
          </p>
        </Q>

        <Q q="How do I add terms and conditions?">
          <p>
            In <strong>Settings</strong>, enter your terms in the "Terms and
            Conditions" box. When set, attendees must tick an agreement checkbox
            before they can reserve tickets. Clear the box to remove the
            requirement.
          </p>
        </Q>
      </Section>

      <Section title="Public Links">
        <Q q="Why do I get a 403 error when sharing my link on Facebook?">
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

      <Section title="Payments">
        <Q q="Which payment providers are supported?">
          <p>
            <strong>Stripe</strong> and <strong>Square</strong>. Choose one in
            Settings and enter your API credentials. You can switch between them
            at any time.
          </p>
        </Q>

        <Q q="What happens when someone books a paid ticket?">
          <p>
            They fill in the booking form, then are redirected to your payment
            provider's checkout page. Their place is held for 5 minutes while
            they pay. Once payment is confirmed, the booking is finalised and
            they receive their ticket.
          </p>
        </Q>

        <Q q="What's the 5-minute reservation window?">
          <p>
            When someone starts paying for a ticket, their place is reserved for
            5 minutes. If they don't complete payment within that time, the
            reservation is released and the place becomes available for others.
            This prevents places being held indefinitely by abandoned checkouts.
          </p>
        </Q>

        <Q q="What if the event sells out while someone is paying?">
          <p>
            If someone completes payment but the event has since sold out, they
            are automatically refunded. They'll see a message explaining the
            event is full and that their payment has been returned.
          </p>
        </Q>

        <Q q="How do refunds work?">
          <p>
            See the <strong>Refunds</strong> section below for full details on
            automatic refunds, admin-issued refunds, and bulk refunds.
          </p>
        </Q>
      </Section>

      <Section title="Payment Setup">
        <Q q="How do I find my Stripe secret key?">
          <ol>
            <li>Log in to your <a href="https://dashboard.stripe.com">Stripe Dashboard</a></li>
            <li>Click <strong>Developers</strong> in the top navigation bar</li>
            <li>Select <strong>API keys</strong> from the sidebar</li>
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

        <Q q="Do I need to set up a Stripe webhook myself?">
          <p>
            No. When you save your Stripe secret key in{" "}
            <a href="/admin/settings">Settings</a>, the system automatically
            creates a webhook endpoint in your Stripe account and stores the
            signing secret. You can verify it's working by clicking the{" "}
            <strong>Test Connection</strong> button that appears after saving
            your key.
          </p>
        </Q>

        <Q q="How do I find my Square access token?">
          <ol>
            <li>
              Log in to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>
            </li>
            <li>Select your application (or create one if you haven't already)</li>
            <li>Open the <strong>Credentials</strong> page</li>
            <li>
              Copy the <strong>Access token</strong> for the environment you want
              (Sandbox for testing, Production for real payments)
            </li>
            <li>
              Paste it into the Square Access Token field on the{" "}
              <a href="/admin/settings">Settings</a> page
            </li>
          </ol>
        </Q>

        <Q q="How do I find my Square location ID?">
          <ol>
            <li>
              Log in to the{" "}
              <a href="https://developer.squareup.com/apps">
                Square Developer Dashboard
              </a>{" "}
              and select your application
            </li>
            <li>Open the <strong>Locations</strong> page in the sidebar</li>
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

        <Q q="How do I set up the Square webhook?">
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
            <li>Navigate to <strong>Webhooks</strong> in the sidebar</li>
            <li>Click <strong>Add Subscription</strong></li>
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

        <Q q="Should I use test or live credentials?">
          <p>
            Start with test credentials to make sure everything is working
            before accepting real payments. Both Stripe and Square provide
            separate test environments:
          </p>
          <ul>
            <li>
              <strong>Stripe:</strong> Use a key starting with{" "}
              <code>sk_test_</code>. You can make test payments with{" "}
              <a href="https://docs.stripe.com/testing#cards">
                Stripe's test card numbers
              </a>.
            </li>
            <li>
              <strong>Square:</strong> Use your Sandbox access token and
              location. You can make test payments with{" "}
              <a href="https://developer.squareup.com/docs/devtools/sandbox/payments">
                Square's sandbox test values
              </a>.
            </li>
          </ul>
          <p>
            When you're ready to go live, replace the test credentials with your
            production credentials in <a href="/admin/settings">Settings</a>.
          </p>
        </Q>
      </Section>

      <Section title="Refunds">
        <Q q="When do automatic refunds happen?">
          <p>
            Automatic refunds happen in two scenarios. First, when an event
            sells out while someone is completing payment. Their place is held
            for 5 minutes during checkout, but if another buyer fills the last
            spot first, the slower payer is automatically refunded and shown a
            message explaining the event is full. Second, if an admin changes
            the event price while someone is mid-checkout. The system detects
            that the amount charged no longer matches the current price and
            refunds the payment automatically. In multi-event bookings, if any
            single event fails (e.g. one of the combined events is full or its
            price changed), the entire payment is refunded &mdash; not just the
            portion for the affected event.
          </p>
        </Q>

        <Q q="How do I refund an individual attendee?">
          <p>
            Open the event's attendee list, find the attendee, and click{" "}
            <strong>Refund</strong>. You'll see a confirmation page showing
            their name, email, quantity, and the amount paid. Type the
            attendee's name to confirm and submit. The refund is issued through
            your payment provider (Stripe or Square) and is always a full
            refund.
          </p>
        </Q>

        <Q q="How do I refund all attendees for an event?">
          <p>
            On the event page, click <strong>Refund All</strong> in the
            navigation bar. Type the event name to confirm. Each attendee with a
            recorded payment is refunded one by one. If some refunds fail (e.g.
            a payment was already refunded via the provider dashboard), you'll
            see a summary of how many succeeded and how many failed.
          </p>
        </Q>

        <Q q="Are partial refunds supported?">
          <p>
            No. The system always issues a full refund for the total amount
            paid. If you need to issue a partial refund, do it directly through
            your payment provider's dashboard (Stripe or Square).
          </p>
        </Q>

        <Q q="What happens to the attendee after a refund?">
          <p>
            The attendee <strong>remains registered</strong>. A refund only
            clears their payment record &mdash; it does not remove them from the
            event. If you also want to remove them, delete the attendee
            separately after refunding.
          </p>
        </Q>

        <Q q="Can I refund an attendee who booked a free event?">
          <p>
            No. The Refund button only appears for attendees who have a recorded
            payment. Free-event attendees have no payment to refund.
          </p>
        </Q>

        <Q q="What if a refund fails?">
          <p>
            The most common reason is that the payment was already refunded
            directly through Stripe or Square. You'll see an error message like
            "Refund failed. The payment may have already been refunded." If your
            payment provider is no longer configured, refunds will also fail
            because there's no provider to process them through.
          </p>
        </Q>

        <Q q="Can I refund the same attendee twice?">
          <p>
            No. After a successful refund the attendee's payment record is
            cleared, so the Refund button no longer appears. If you attempt to
            refund a payment that was already refunded via the provider
            dashboard, the provider will reject it and you'll see a failure
            message.
          </p>
        </Q>
      </Section>

      <Section title="Daily Events &amp; Holidays">
        <Q q="How do daily events work?">
          <p>
            Daily events let attendees choose a specific date when booking. You
            set which days of the week are available (e.g. Monday to Friday) and
            how far in advance people can book. The capacity limit applies
            independently to each date.
          </p>
        </Q>

        <Q q="What are bookable days?">
          <p>
            These are the days of the week your daily event runs on. If you only
            tick Monday and Wednesday, those are the only days that appear in the
            date picker. Weekends and unticked days are skipped.
          </p>
        </Q>

        <Q q="What are holidays?">
          <p>
            Holidays are date ranges when no daily events can be booked. Add
            them from the <strong>Holidays</strong> page. Any dates falling
            within a holiday range are removed from the booking calendar for all
            daily events.
          </p>
        </Q>
      </Section>

      <Section title="Check-in &amp; QR Scanner">
        <Q q="How does check-in work?">
          <p>
            Each ticket has a unique QR code. When an attendee arrives, they
            show their QR code to a member of staff. The staff member scans it
            (or opens the link), which takes them to the check-in page. If
            logged in as an admin, they'll see the attendee's details and
            ticket quantity, with a button to check them in or out.
          </p>
        </Q>

        <Q q="What's the QR code for?">
          <p>
            The QR code links to the ticket's check-in page. Scanning it opens
            the page in a browser. Non-admin visitors see a message to show the
            code to staff. Admin visitors see the attendee's details and a
            check-in button.
          </p>
        </Q>

        <Q q="How do I use the QR scanner?">
          <p>
            Open an event and click <strong>Scanner</strong>. Tap{" "}
            <strong>Start Camera</strong> to begin (grants camera permission on
            first use). Point the camera at an attendee's QR code and check-in
            happens automatically. A 2-second cooldown prevents duplicate scans.
            The scanner works best with the rear camera on mobile devices.
          </p>
        </Q>

        <Q q="Why doesn't the scanner check people out?">
          <p>
            The scanner is intentionally one-way: it only checks people{" "}
            <strong>in</strong>, never out. This prevents accidental check-outs
            from double-scans at a busy door. To check someone out, use the
            manual check-in page instead.
          </p>
        </Q>

        <Q q="What if a QR code is for a different event?">
          <p>
            If you scan a ticket registered for a different event, you'll be
            prompted to confirm before checking them in. This lets you handle
            last-minute event changes without turning anyone away.
          </p>
        </Q>

        <Q q="What do the scanner status messages mean?">
          <p>
            <strong>Checked in</strong> &mdash; shows the attendee's name and
            ticket count (e.g. "Jo checked in (2 tickets)").{" "}
            <strong>Already checked in</strong> &mdash; they were already
            marked as arrived. <strong>Ticket not found</strong> &mdash; the QR
            code doesn't match any registration.{" "}
            <strong>Different event</strong> &mdash; a confirmation dialogue
            asks whether to check them in anyway.
          </p>
        </Q>
      </Section>

      <Section id="user-classes" title="Users &amp; Permissions">
        <Q q="What's the difference between an owner and a manager?">
          <p>
            <strong>Owners</strong> have full access: events, calendar, users,
            settings, holidays, sessions, and the activity log.{" "}
            <strong>Managers</strong> can only see events and the calendar. They
            cannot change settings, manage users, or view the activity log.
          </p>
        </Q>

        <Q q="How do I invite another admin?">
          <p>
            Go to <strong>Users</strong>, enter a username and choose their role
            (owner or manager). You'll receive an invite link to send them. They
            use the link to set their password and activate their account.
          </p>
        </Q>

        <Q q="How long do invite links last?">
          <p>
            Invite links expire after <strong>7 days</strong>. If the link
            expires before the person uses it, you'll need to delete the pending
            user and create a new invite.
          </p>
        </Q>
      </Section>

      <Section title="Data &amp; Privacy">
        <Q q="How is attendee data protected?">
          <p>
            All personal information (names, email addresses, phone numbers,
            postal addresses) is encrypted before being stored. Even if the database were
            compromised, the data cannot be read without the encryption keys.
            Data is only decrypted when an authenticated admin views it.
          </p>
        </Q>

        <Q q="What happens if I lose my password?">
          <p>
            There is <strong>no password recovery</strong>. If you lose your
            password, you cannot log in or decrypt any data. Keep your password
            safe. Another owner can delete your account and send a fresh
            invite, and all existing attendee data remains accessible to other
            admins.
          </p>
        </Q>

        <Q q="Can I export attendee data?">
          <p>
            Yes. On any event's attendee list, click <strong>Export CSV</strong>.
            The export includes name, email, phone, address, special
            instructions, quantity, registration date, amount paid, transaction
            ID, check-in status, and ticket URL. For daily events, you can
            filter by date before exporting.
          </p>
        </Q>

        <Q q="What does 'reset database' do?">
          <p>
            It permanently deletes <strong>everything</strong>: all events,
            attendees, users, payment configuration, and sessions. The system
            returns to its initial setup state. You must type a confirmation
            phrase to proceed. This cannot be undone.
          </p>
        </Q>
      </Section>

      <Section title="Webhooks">
        <Q q="What are webhooks for?">
          <p>
            Webhooks send an automatic notification to a URL of your choice
            whenever someone registers for an event. You can use them to
            connect to other services, e.g. sending a Slack message or updating
            a spreadsheet.
          </p>
        </Q>

        <Q q="How do I set up a webhook?">
          <p>
            Add a webhook URL when creating or editing an event. Every time
            someone books that event, a POST request is sent to your URL with
            the attendee's details. You can also set a global webhook URL via
            the <code>WEBHOOK_URL</code> environment variable, which receives
            notifications for all events.
          </p>
        </Q>
      </Section>

      <Section title="Sessions">
        <Q q="What are sessions?">
          <p>
            A session is created each time an admin logs in. Sessions expire
            after 24 hours. You can view all active sessions from the{" "}
            <strong>Sessions</strong> page.
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
      </Section>

      <Section title="Customising Your Site">
        <Q q="Can I customise this system?">
          <p>
            Absolutely. This is open-source software, so you have full control.
            You can{" "}
            <a href="https://github.com/chobble-mirror/tickets">
              grab the code from GitHub
            </a>{" "}
            and host it yourself on Bunny Edge Scripting or any compatible
            platform. The README has deployment instructions to get you started.
          </p>
        </Q>

        <Q q="Can you customise it for me?">
          <p>
            Yes. I offer customisation at a transparent flat rate &mdash; see{" "}
            <a href="https://chobble.com/prices">chobble.com/prices</a> for
            current pricing. I can help you with custom features, branding,
            event image design, hosting setup, or whatever you need. You'll own
            the code outright, and I can show you how to maintain it yourself or
            handle updates for you. Over 20 years building web systems means I
            can usually solve problems quickly and clearly.
          </p>
        </Q>

        <Q q="Do you help with hosting and images?">
          <p>
            Yes to both. I can set you up on your own Bunny CDN account (or
            another host) and handle the technical configuration. I also design
            event images if you need them &mdash; clean, professional graphics
            that match your brand. Get in touch and we'll figure out exactly
            what you need.
          </p>
        </Q>
      </Section>
    </Layout>
  );
