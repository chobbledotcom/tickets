/**
 * Seed data page template - lets admins populate the database with sample data
 */

import { CsrfForm, renderError } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { SeedResult } from "#lib/seeds.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Success message after seeding */
const SeedSuccess = ({ result }: { result: SeedResult }): JSX.Element => (
  <article>
    <aside>
      <p>
        Created <strong>{result.eventsCreated}</strong> event(s) with{" "}
        <strong>{result.attendeesCreated}</strong> attendee(s) total.
      </p>
    </aside>
  </article>
);

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  result?: SeedResult,
): string =>
  String(
    <Layout title="Seed Data">
      <AdminNav session={session} active="" />
      <h1>Seed Data</h1>
      <p>
        Create sample events and attendees from demo data. Useful for testing
        and development.
      </p>

      <Raw html={renderError(error)} />
      {result && <SeedSuccess result={result} />}

      <CsrfForm action="/admin/seeds">
        <label for="event_count">Number of events</label>
        <input
          type="number"
          id="event_count"
          name="event_count"
          value="5"
          min="1"
          max="30"
          required
        />

        <label for="attendees_per_event">Attendees per event</label>
        <input
          type="number"
          id="attendees_per_event"
          name="attendees_per_event"
          value="10"
          min="0"
          max="50"
          required
        />

        <button type="submit">Create Seed Data</button>
      </CsrfForm>

      <p>
        <a href="/admin">&larr; Back to dashboard</a>
      </p>
    </Layout>,
  );
