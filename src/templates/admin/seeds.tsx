/**
 * Seed data page template - lets admins populate the database with sample data
 */

import { CsrfForm, renderError, renderSuccess } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { SeedResult } from "#lib/seeds.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Format seed result as a success message string */
const formatSeedResult = (result: SeedResult): string =>
  `Created ${result.eventsCreated} event(s) with ${result.attendeesCreated} attendee(s) total.`;

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
      <Raw
        html={renderSuccess(result ? formatSeedResult(result) : undefined)}
      />

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
          max="1000"
          required
        />

        <button type="submit">Create Seed Data</button>
      </CsrfForm>

      <p>
        <a href="/admin">&larr; Back to dashboard</a>
      </p>
    </Layout>,
  );
