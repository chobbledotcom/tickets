/**
 * Admin QR scanner page template
 */

import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { SCANNER_JS_PATH } from "#src/config/asset-paths.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/**
 * Scanner page - camera feed with auto check-in
 */
export const adminScannerPage = (
  event: EventWithCount,
  session: AdminSession,
): string =>
  String(
    <Layout
      title={`Scanner: ${event.name}`}
      headExtra={`<meta name="csrf-token" content="${session.csrfToken}" /><script src="${SCANNER_JS_PATH}" defer></script>`}
    >
      <AdminNav session={session} />
      <h1>Scanner</h1>
      <p><a href={`/admin/event/${event.id}`}>&larr; {event.name}</a></p>

      <article>
        <div id="scanner-status" style="display:none"></div>

        <video
          id="scanner-video"
          data-event-id={String(event.id)}
          playsinline
          muted
          style="display:none; width:100%; max-width:500px; border-radius:4px"
        ></video>
        <canvas id="scanner-canvas" style="display:none"></canvas>

        <button id="scanner-start" type="button">
          Start Camera
        </button>
      </article>
    </Layout>
  );
