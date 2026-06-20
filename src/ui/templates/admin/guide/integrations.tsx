/**
 * Admin guide — Integrations sections.
 */

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
  faq,
  type GuideSection,
} from "#templates/admin/guide/components.tsx";

export const integrationsSections = (): GuideSection[] => [
  {
    entries: [
      faq("listing_feeds"),
      custom(
        "connect_to_mobilizon",
        <>
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
          The SMS gateway lets you send text messages to attendees from an
          attendee's <strong>Contact</strong> page, using a spare Android phone
          as the sender. It uses the free, open-source{" "}
          <a href="https://sms-gate.app">SMS Gateway for Android</a> app: you
          install the app on a phone, and this site sends messages through it.
          There is no per-message cost beyond your phone's normal SMS allowance.
        </p>,
      ),
      custom(
        "sms_data_privacy",
        <p>
          Message text and recipient phone numbers are{" "}
          <strong>end-to-end encrypted</strong> with a passphrase you choose,
          before they ever leave this server. The relay only ever sees
          ciphertext &mdash; only your phone, which holds the same passphrase,
          can decrypt and send. Attendee phone numbers are decrypted briefly
          under your login, re-encrypted with the gateway key, and never stored
          in plain text.
        </p>,
      ),
      custom(
        "sms_setup",
        <ol>
          <li>
            Install the{" "}
            <a href="https://sms-gate.app">SMS Gateway for Android</a> app on a
            phone and register for the free cloud account it offers. The app
            then shows you a <strong>username and password</strong> for that
            cloud account.
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
          Yes. When you set a webhook signing secret and point the app's webhook
          at <code>/sms/webhook</code> on this site, delivery confirmations,
          failures, and incoming replies are recorded in the{" "}
          <a href="/admin/log">activity log</a> against the relevant attendee,
          so you have a full history of the conversation. Each message is stored
          encrypted and only readable by signed-in admins.
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
        </>,
      ),
      custom(
        "list_listings_api",
        <>
          <pre>
            <code>{`GET /api/listings\n\nResponse:\n${API_LIST_EXAMPLE_JSON}`}</code>
          </pre>
          <p>
            Prices are in the smallest currency unit (e.g. pence for GBP, cents
            for USD). <code>maxPurchasable</code> is 0 when the listing is sold
            out or registration is closed.
          </p>
        </>,
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
      faq("how_do_i_revoke_an_api_key"),
      faq("what_happens_to_api_keys_if_their"),
    ],
    id: "admin-api",
    titleKey: "admin_api",
  },
];
