/**
 * Admin guide — Integrations sections.
 */

import type { Child } from "#jsx/jsx-runtime.ts";
import {
  API_AVAILABILITY_EXAMPLE_JSON,
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
  API_BOOK_REQUEST_JSON,
  API_LIST_EXAMPLE_JSON,
  API_SINGLE_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  custom,
  ExampleCode,
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

/**
 * A JSON example `<pre>` block followed by the shared "prices are in the
 * smallest currency unit" note. `children` supplies the note's trailing,
 * per-endpoint sentence. Shared with the webhooks answer in accounts.tsx.
 */
export const PricedJsonExample = ({
  children,
  json,
}: {
  children?: Child;
  json: string;
}): JSX.Element => (
  <>
    <pre>
      <code>{json}</code>
    </pre>
    <p>
      Prices are in the smallest currency unit (e.g. pence for GBP, cents for
      USD). {children}
    </p>
  </>
);

/** The SMS Gateway for Android app link, used across the SMS guide entries. */
const SmsGatewayAppLink = (): JSX.Element => (
  <a href="https://sms-gate.app">SMS Gateway for Android</a>
);

export const integrationsSections = (): GuideSection[] => [
  {
    entries: [
      faq("listing_feeds"),
      custom(
        "connect_to_mobilizon",
        <>
          <p>
            <a href="https://mobilizon.org/">Mobilizon</a> is a website for
            listing events, used by groups who avoid big platforms. You can pull
            your listings into it from your calendar feed:
          </p>
          <ol>
            <li>
              On your Mobilizon instance, go to the event import tool (or use
              the public importer at{" "}
              <a href="https://import.mobilizon.fr/">import.mobilizon.fr</a>)
            </li>
            <li>
              Enter your calendar feed address:{" "}
              <code>https://{getEffectiveDomain()}/feeds/listings.ics</code>
            </li>
            <li>
              Set <strong>joinMode</strong> to <strong>external</strong>, so the
              &quot;Join&quot; button on Mobilizon sends people to your booking
              page
            </li>
          </ol>
          <p>
            Your listings then appear on Mobilizon, and other Mobilizon sites
            can share them. People click through to your site to book and pay.
          </p>
        </>,
      ),
    ],
    titleKey: "feeds_and_mobilizon",
  },
  {
    entries: [
      custom(
        "what_is_sms_gateway",
        <p>
          A gateway is a bridge between two systems. This one lets you text
          attendees from an attendee's <strong>Contact</strong> page, using a
          spare Android phone as the sender. It works with the free{" "}
          <SmsGatewayAppLink /> app: install the app on a phone, and this site
          sends messages through it. There is no cost per message beyond your
          phone's normal text allowance.
        </p>,
      ),
      custom(
        "sms_data_privacy",
        <p>
          Message text and phone numbers are{" "}
          <strong>end-to-end encrypted</strong> before they ever leave this site
          — locked with a passphrase only you and your phone know, so the
          service in between only ever sees scrambled text. Attendee phone
          numbers are unlocked only for a moment while you are signed in, then
          locked again, and are never stored in readable form.
        </p>,
      ),
      custom(
        "sms_setup",
        <ol>
          <li>
            Install the <SmsGatewayAppLink /> app on a phone and register for
            the free cloud account it offers. The app then shows you a{" "}
            <strong>username and password</strong> for that cloud account.
          </li>
          <li>
            In the app, enable <strong>end-to-end encryption</strong> and set a
            passphrase of <strong>at least 12 characters</strong>. This is the
            only secret protecting your attendees' phone numbers and messages,
            so make it long and unique.
          </li>
          <li>
            In{" "}
            <a href="/admin/settings-advanced#settings-sms-gateway">
              Advanced Settings &rarr; SMS Gateway
            </a>
            , enter that username and password from the phone app (these are the
            app's own credentials, not your login here or this site's API keys),
            along with the <strong>same passphrase</strong> you set on the
            phone.
          </li>
          <li>
            Open any attendee and choose <strong>Send Text</strong> to message
            them.
          </li>
        </ol>,
      ),
      custom(
        "sms_replies",
        <p>
          Yes. In the app's webhook settings, point the webhook at{" "}
          <code>/sms/webhook</code> on this site, and set its signing key to
          match the one in your{" "}
          <a href="/admin/settings-advanced#settings-sms-gateway">
            SMS settings
          </a>
          . Then every delivery report, failure, and reply is recorded in the{" "}
          <a href="/admin/log">activity log</a> against the right attendee, so
          you keep the whole conversation. Each message is stored encrypted and
          readable only by signed-in admins.
        </p>,
      ),
    ],
    id: "sms",
    titleKey: "sms_gateway",
  },
  {
    entries: [
      faq("what_is_public_api"),
      custom(
        "available_endpoints",
        <>
          <p>
            The starting address is your own site address (for example{" "}
            <code>https://{getEffectiveDomain()}</code>). Every answer comes
            back as JSON, a text shape computer programs read.
          </p>
          <ul>
            <li>
              <code>GET /api/listings</code> &mdash; list every open, non-hidden
              listing
            </li>
            <li>
              <code>GET /api/listings/:slug</code> &mdash; read one listing by
              its slug (the word ending of its address; hidden listings can be
              read if you know the slug)
            </li>
            <li>
              <code>
                GET
                /api/listings/:slug/availability?quantity=N&amp;date=YYYY-MM-DD
              </code>{" "}
              &mdash; check whether places are free
            </li>
            <li>
              <code>POST /api/listings/:slug/book</code> &mdash; make a booking
            </li>
          </ul>
          <p>
            The API can be called from any website, including other people's
            &mdash; that is the point.
          </p>
        </>,
      ),
      custom(
        "list_listings_api",
        <PricedJsonExample
          json={`GET /api/listings\n\nResponse:\n${API_LIST_EXAMPLE_JSON}`}
        >
          <code>maxPurchasable</code> is 0 when the listing is sold out or
          registration is closed.
        </PricedJsonExample>,
      ),
      custom(
        "get_single_listing_api",
        <>
          <pre>
            <code>{`GET /api/listings/summer-workshop\n\nResponse:\n${API_SINGLE_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            The <code>availableDates</code> field is only included for daily
            listings. Returns <code>{'{ "error": "Listing not found" }'}</code>{" "}
            with status 404 if the listing doesn&apos;t exist or is inactive.
          </p>
        </>,
      ),
      custom(
        "check_availability_api",
        <>
          <pre>
            <code>{`GET /api/listings/summer-workshop/availability?quantity=2\n\nResponse:\n${API_AVAILABILITY_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            For daily listings, add <code>&amp;date=YYYY-MM-DD</code> to check a
            specific date. The <code>quantity</code> parameter defaults to 1.
          </p>
        </>,
      ),
      custom(
        "create_booking_api",
        <>
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
          <ExampleCode
            code={API_BOOK_FREE_EXAMPLE_JSON}
            label="Free listing response:"
          />
          <ExampleCode
            code={API_BOOK_PAID_EXAMPLE_JSON}
            label="Paid listing response:"
          />
          <p>
            Redirect the user to <code>checkoutUrl</code> to complete payment.
            Possible error responses: 400 (validation error or registration
            closed), 404 (listing not found), 409 (not enough spots available).
          </p>
        </>,
      ),
      faq("api_data_exposure"),
      faq("where_can_i_find_the_full_api"),
    ],
    id: "api",
    titleKey: "public_api",
  },
  {
    entries: [
      faq("what_is_the_admin_api"),
      faq("how_do_i_create_an_api_key"),
      faq("how_do_i_authenticate"),
      faq("what_admin_endpoints_are_available"),
      faq("how_do_i_read_groups_and_members"),
      faq("how_do_i_revoke_an_api_key"),
      faq("what_happens_to_api_keys_if_their"),
    ],
    id: "admin-api",
    titleKey: "admin_api",
  },
];
