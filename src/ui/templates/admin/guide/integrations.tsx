/**
 * Admin guide — Integrations sections.
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
import { getEffectiveDomain } from "#shared/config.ts";
import { Faq, Q, Section } from "#templates/admin/guide/components.tsx";

export const Integrations = (): JSX.Element => (
  <>
    <Section title={t("guide.sections.feeds_and_mobilizon")}>
      <Faq id="listing_feeds" />

      <Q q={t("guide.q.connect_to_mobilizon")}>
        <p>
          <a href="https://mobilizon.org/">Mobilizon</a> is a federated events
          platform. You can use its built-in importer to pull listings from your
          ICS feed:
        </p>
        <ol>
          <li>
            On your Mobilizon instance, go to the event import tool (or use the
            public importer at{" "}
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
      <Faq id="what_is_public_api" />

      <Q q={t("guide.q.available_endpoints")}>
        <p>
          The base URL is your domain (e.g.{" "}
          <code>https://{getEffectiveDomain()}</code>). All responses are JSON.
        </p>
        <ul>
          <li>
            <code>GET /api/listings</code> &mdash; list all active, non-hidden
            listings
          </li>
          <li>
            <code>GET /api/listings/:slug</code> &mdash; get a single listing by
            its slug (hidden listings are accessible if you know the slug)
          </li>
          <li>
            <code>
              GET
              /api/listings/:slug/availability?quantity=N&amp;date=YYYY-MM-DD
            </code>{" "}
            &mdash; check if spots are available
          </li>
          <li>
            <code>POST /api/listings/:slug/book</code> &mdash; create a booking
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
          Which fields are required depends on the listing's field settings. The{" "}
          <code>name</code> field is always required. <code>date</code> is
          required for daily listings (use a date from{" "}
          <code>availableDates</code>). <code>customPrice</code> is for pay-more
          listings only (in major currency units, e.g. 10.00 for &pound;10).
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

      <Faq id="api_data_exposure" />

      <Faq id="where_can_i_find_the_full_api" />
    </Section>

    <Section id="admin-api" title="Admin API">
      <Faq id="what_is_the_admin_api" />

      <Faq id="how_do_i_create_an_api_key" />

      <Faq id="how_do_i_authenticate" />

      <Faq id="what_admin_endpoints_are_available" />

      <Faq id="how_do_i_revoke_an_api_key" />

      <Faq id="what_happens_to_api_keys_if_their" />
    </Section>
  </>
);
