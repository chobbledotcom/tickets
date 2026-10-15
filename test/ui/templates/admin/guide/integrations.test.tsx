import { describe, it as test } from "@std/testing/bdd";
import {
  API_BOOK_FREE_EXAMPLE_JSON,
  API_BOOK_PAID_EXAMPLE_JSON,
} from "#shared/api-example.ts";
import {
  ExampleCode,
  renderGuideSections,
} from "#templates/admin/guide/components.tsx";
import {
  integrationsSections,
  PricedJsonExample,
} from "#templates/admin/guide/integrations.tsx";
import { says } from "#test-utils/says.ts";

/** What a `<code>` body shows: JSX escapes double quotes as entities. */
const shown = (code: string): string => code.replaceAll('"', "&quot;");

describe("guide integrations section", () => {
  test("the booking example answers are labelled and code-fenced", () => {
    const html = String(renderGuideSections(integrationsSections()));
    says(html, "<p><strong>Free listing response:</strong></p>");
    says(html, `<pre><code>${shown(API_BOOK_FREE_EXAMPLE_JSON)}</code></pre>`);
    says(html, "<p><strong>Paid listing response:</strong></p>");
    says(html, `<pre><code>${shown(API_BOOK_PAID_EXAMPLE_JSON)}</code></pre>`);
  });

  test("PricedJsonExample code-fences its JSON, then notes the currency unit", () => {
    const html = String(
      PricedJsonExample({
        children: <>Amounts include the booking fee.</>,
        json: API_BOOK_FREE_EXAMPLE_JSON,
      }),
    );
    says(html, `<pre><code>${shown(API_BOOK_FREE_EXAMPLE_JSON)}</code></pre>`);
    says(html, "smallest currency unit (e.g. pence for GBP");
    says(html, "Amounts include the booking fee.");
  });

  test("ExampleCode pairs a bold label with its code block", () => {
    const html = String(
      <ExampleCode code='{"a":1}' label="Free listing response:" />,
    );
    says(
      html,
      `<p><strong>Free listing response:</strong></p><pre><code>${shown('{"a":1}')}</code></pre>`,
    );
  });

  test("the guide's links, anchors, and inline-code joins stay intact", () => {
    const html = String(renderGuideSections(integrationsSections()));
    // Links the sections are reachable through.
    says(html, '<a href="https://sms-gate.app">');
    says(html, '<a href="https://mobilizon.org/">');
    says(html, '<a href="https://import.mobilizon.fr/">');
    says(html, '<a href="/admin/settings-advanced#settings-sms-gateway">');
    says(html, '<a href="/admin/log">');
    // The anchor ids the guide's own footer deep-links use.
    says(html, '<h3 id="sms">');
    says(html, '<h3 id="api">');
    says(html, '<h3 id="admin-api">');
    // The joins between prose and its inline code: exactly one space each.
    says(html, "the public importer at <a href=");
    says(html, "Enter your calendar feed address: <code>https://");
    says(html, "works with the free <a href=");
    says(html, "Message text and phone numbers are <strong>end-to-end");
    says(html, "shows you a <strong>username and password</strong>");
    says(html, "recorded in the <a href=");
    says(
      html,
      "The starting address is your own site address (for example <code>https://",
    );
    says(
      html,
      "Returns <code>{ &quot;error&quot;: &quot;Listing not found&quot; }</code> with status 404",
    );
    // The app link join: the link text and the following word share one space.
    says(html, ">SMS Gateway for Android</a> app: install the app");
    // The settings link begins its list item with one space after "In".
    says(html, "In <a href=");
    // The wrapped availability code block joins its dash with one space too.
    says(html, "date=YYYY-MM-DD</code> — check whether places are free");
    // The daily-listing parameter note joins its inline code the same way.
    says(
      html,
      "For daily listings, add <code>&amp;date=YYYY-MM-DD</code> to check",
    );
    says(html, "(use a date from <code>availableDates</code>)");
  });
});
