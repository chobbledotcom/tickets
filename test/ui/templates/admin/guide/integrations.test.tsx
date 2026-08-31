import { expect } from "@std/expect";
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

/** What a `<code>` body shows: JSX escapes double quotes as entities. */
const shown = (code: string): string => code.replaceAll('"', "&quot;");

describe("guide integrations section", () => {
  test("the booking example answers are labelled and code-fenced", () => {
    const html = String(renderGuideSections(integrationsSections()));
    expect(html).toContain("<p><strong>Free listing response:</strong></p>");
    expect(html).toContain(
      `<pre><code>${shown(API_BOOK_FREE_EXAMPLE_JSON)}</code></pre>`,
    );
    expect(html).toContain("<p><strong>Paid listing response:</strong></p>");
    expect(html).toContain(
      `<pre><code>${shown(API_BOOK_PAID_EXAMPLE_JSON)}</code></pre>`,
    );
  });

  test("PricedJsonExample code-fences its JSON, then notes the currency unit", () => {
    const html = String(
      PricedJsonExample({
        children: <>Amounts include the booking fee.</>,
        json: API_BOOK_FREE_EXAMPLE_JSON,
      }),
    );
    expect(html).toContain(
      `<pre><code>${shown(API_BOOK_FREE_EXAMPLE_JSON)}</code></pre>`,
    );
    expect(html).toContain("smallest currency unit (e.g. pence for GBP");
    expect(html).toContain("Amounts include the booking fee.");
  });

  test("ExampleCode pairs a bold label with its code block", () => {
    const html = String(
      <ExampleCode code='{"a":1}' label="Free listing response:" />,
    );
    expect(html).toContain(
      `<p><strong>Free listing response:</strong></p><pre><code>${shown('{"a":1}')}</code></pre>`,
    );
  });

  test("the guide's links, anchors, and inline-code joins stay intact", () => {
    const html = String(renderGuideSections(integrationsSections()));
    // Links the sections are reachable through.
    expect(html).toContain('<a href="https://sms-gate.app">');
    expect(html).toContain('<a href="https://mobilizon.org/">');
    expect(html).toContain('<a href="https://import.mobilizon.fr/">');
    expect(html).toContain(
      '<a href="/admin/settings-advanced#settings-sms-gateway">',
    );
    expect(html).toContain('<a href="/admin/log">');
    // The anchor ids the guide's own footer deep-links use.
    expect(html).toContain('<h3 id="sms">');
    expect(html).toContain('<h3 id="api">');
    expect(html).toContain('<h3 id="admin-api">');
    // The joins between prose and its inline code: exactly one space each.
    expect(html).toContain("the public importer at <a href=");
    expect(html).toContain("Enter your ICS feed URL: <code>https://");
    expect(html).toContain("open-source <a href=");
    expect(html).toContain(
      "Message text and recipient phone numbers are <strong>end-to-end",
    );
    expect(html).toContain(
      "shows you a <strong>username and password</strong>",
    );
    expect(html).toContain("recorded in the <a href=");
    expect(html).toContain("The base URL is your domain (e.g. <code>https://");
    expect(html).toContain(
      "Returns <code>{ &quot;error&quot;: &quot;Listing not found&quot; }</code> with status 404",
    );
    // The app link join: the link text and the following word share one space.
    expect(html).toContain(
      ">SMS Gateway for Android</a> app: you install the app",
    );
    // The settings link begins its list item with one space after "In".
    expect(html).toContain("In <a href=");
    // The wrapped availability code block joins its dash with one space too.
    expect(html).toContain(
      "date=YYYY-MM-DD</code> — check if spots are available",
    );
    // The daily-listing parameter note joins its inline code the same way.
    expect(html).toContain(
      "For daily listings, add <code>&amp;date=YYYY-MM-DD</code> to check",
    );
    expect(html).toContain("(use a date from <code>availableDates</code>)");
  });
});
