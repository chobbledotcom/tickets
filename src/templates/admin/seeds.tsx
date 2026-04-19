/**
 * Seed data page template - lets admins populate the database with sample data
 */

import { CsrfForm, Flash } from "#lib/forms.tsx";
import { SEED_MAX_ATTENDEES } from "#lib/seeds.ts";
import type { AdminSession } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Seed data admin page */
export const adminSeedsPage = (
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Seed Data">
      <AdminNav active="" session={session} />
      <CsrfForm action="/admin/seeds">
        <h1>Seed Data</h1>
        <p>
          Create sample events and attendees from demo data. Useful for testing
          and development.
        </p>
        <Flash error={error} success={success} />
        <label for="event_count">Number of events</label>
        <input
          id="event_count"
          max="30"
          min="1"
          name="event_count"
          required
          type="number"
          value="5"
        />

        <label for="attendees_per_event">Attendees per event</label>
        <input
          id="attendees_per_event"
          max={String(SEED_MAX_ATTENDEES)}
          min="0"
          name="attendees_per_event"
          required
          type="number"
          value="10"
        />

        <button type="submit">Create Seed Data</button>
      </CsrfForm>

      <p>
        <a href="/admin">&larr; Back to dashboard</a>
      </p>
    </Layout>,
  );
