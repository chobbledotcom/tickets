/**
 * Admin guide page template - FAQ-style help for administrators
 */

import type { Child } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

const Section = ({
  title,
  children,
}: {
  title: string;
  children?: Child;
}): JSX.Element => (
  <>
    <h3>{title}</h3>
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
            contact details to collect (any combination of email, phone, and
            postal address). You can leave the price blank for free events.
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
            Use an iframe pointing to your event's booking URL with{" "}
            <code>?iframe=true</code> appended, e.g.{" "}
            <code>/ticket/my-event?iframe=true</code>. In{" "}
            <strong>Settings</strong>, add your website's domain to the embed
            hosts list so the browser allows the iframe to load.
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

      <Section title="Refunds">
        <Q q="When do automatic refunds happen?">
          <p>
            Automatic refunds only happen in one scenario: when an event sells
            out while someone is completing payment. Their place is held for 5
            minutes during checkout, but if another buyer fills the last spot
            first, the slower payer is automatically refunded and shown a message
            explaining the event is full. In multi-event bookings, if any single
            event fails (e.g. one of the combined events is full), the entire
            payment is refunded &mdash; not just the portion for the sold-out
            event.
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
            logged in as an admin, they'll see a button to toggle the attendee's
            check-in status.
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
            <strong>Checked in</strong> &mdash; attendee successfully checked
            in. <strong>Already checked in</strong> &mdash; they were already
            marked as arrived. <strong>Ticket not found</strong> &mdash; the QR
            code doesn't match any registration.{" "}
            <strong>Different event</strong> &mdash; the ticket belongs to
            another event (you can force check-in if needed).
          </p>
        </Q>
      </Section>

      <Section title="Users &amp; Permissions">
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
            There is <strong>no password recovery</strong>. Attendee data is
            encrypted using keys derived from your password, so without it the
            data cannot be decrypted. Keep your password safe. Another owner can
            delete and re-invite your account, but previously encrypted data
            tied to your keys alone cannot be recovered.
          </p>
        </Q>

        <Q q="Can I export attendee data?">
          <p>
            Yes. On any event's attendee list, click <strong>Export CSV</strong>.
            The export includes name, email, phone, address, quantity,
            registration date, amount paid, check-in status, and ticket link. For daily events, you
            can filter by date before exporting.
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
    </Layout>
  );
