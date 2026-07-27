import * as v from "valibot";
import {
  type EvidenceCaptureDeclaration,
  EvidenceCaptureDeclarationSchema,
} from "./schema.ts";

const brandedThemeCss = (
  borderRadius: string,
  accent: string,
  background: string,
  secondaryBackground: string,
  link: string,
  secondary: string,
  secondaryAccent: string,
  shadow: string,
  table: string,
  text: string,
  secondaryText: string,
): string => `
:root {
  --border-radius: ${borderRadius};
  --color-accent: ${accent};
  --color-bg: ${background};
  --color-bg-secondary: ${secondaryBackground};
  --color-link: ${link};
  --color-secondary: ${secondary};
  --color-secondary-accent: ${secondaryAccent};
  --color-shadow: ${shadow};
  --color-table: ${table};
  --color-text: ${text};
  --color-text-secondary: ${secondaryText};
  --font-family: Arial, Helvetica, sans-serif;
}
`;

const SERVICING_STUDIO_CSS = `${brandedThemeCss(
  "5px",
  "#c28b52",
  "#e9edef",
  "#d8e0e3",
  "#315b67",
  "#315b67",
  "#315b6718",
  "#263f4724",
  "#315b67",
  "#27383d",
  "#66777c",
)}

#servicing-form {
  background: #f9faf8;
  border: 1px solid #bdc9ca;
  border-left: 7px solid var(--color-secondary);
  border-radius: 6px;
  box-shadow: 0 12px 28px var(--color-shadow);
  padding: 1rem;
}

#servicing-form label {
  color: #294852;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

#servicing-form input {
  background: #fff;
  border-color: #aebdbf;
  border-radius: 3px;
}

#servicing-form .table-scroll {
  overflow: visible;
}

#servicing-form table {
  font-size: 0.82rem;
  table-layout: fixed;
  white-space: normal;
  width: 100%;
}

#servicing-form th,
#servicing-form td {
  padding: 0.45rem;
}

#servicing-form th:last-child,
#servicing-form td:last-child {
  width: 5rem;
}

#servicing-form button[type="submit"] {
  background: var(--color-accent);
  border-color: #a66f39;
  border-radius: 3px;
  color: #2e251d;
  font-weight: 800;
  width: 100%;
}
`;

const PAYMENT_PROVIDER_CSS = `${brandedThemeCss(
  "8px",
  "#d7ab48",
  "#eef3f2",
  "#dde8e5",
  "#245e59",
  "#244c48",
  "#244c4818",
  "#1e454020",
  "#244c48",
  "#263a38",
  "#647471",
)}

.admin-page {
  background: #fff;
  border: 1px solid #c9d8d4;
  border-top: 6px solid var(--color-accent);
  box-shadow: 0 12px 28px var(--color-shadow);
  padding: 1rem;
}

.admin-page > form:not(#settings-payment-provider):not(#settings-stripe),
.admin-page > article,
.admin-page > footer {
  display: none;
}

#settings-payment-provider,
#settings-stripe {
  background: #f8faf9;
  border: 1px solid #c9d8d4;
  border-radius: var(--border-radius);
  padding: 1rem;
}

#settings-payment-provider h2,
#settings-stripe h2 {
  color: var(--color-secondary);
}

#settings-payment-provider .radio-option {
  background: #fff;
  border-color: #c9d8d4;
}

#settings-stripe .notice {
  border-left: 5px solid var(--color-accent);
}
`;

const DOOR_CHECK_IN_CSS = `${brandedThemeCss(
  "8px",
  "#164e63",
  "#071525",
  "#10283c",
  "#67e8f9",
  "#22d3ee",
  "#22d3ee1f",
  "#02081780",
  "#22d3ee",
  "#e6f7fb",
  "#9bb7c5",
)}

#manual-checkin {
  background: #0b1d2e;
  border: 1px solid #25758b;
  border-radius: 8px;
  box-shadow: 0 12px 28px var(--color-shadow);
  padding: 1rem;
}

#manual-checkin label {
  color: #bdeff7;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

#manual-checkin input[type="text"] {
  background: #071525;
  border: 1px solid #2f7188;
  border-radius: 6px;
  color: var(--color-text);
}

/* The page's own script opens the list of people still to arrive once the
 * organiser starts typing. A capture is a plain page load, so show the list
 * the scenario proves is offered. */
/* The search box's placeholder is drawn by the input's own text layer, which
 * rasterises differently from run to run and would change the captured bytes
 * without changing what the page says. The label above the box already says
 * what the box is for, so the capture leaves it empty. */
#manual-checkin input::placeholder {
  color: transparent;
}

#ticket-options.hidden {
  display: block;
}

#ticket-options {
  margin-top: 0.5rem;
  position: static;
}

#ticket-options [role="option"] {
  background: #0d3a42;
  border: 1px solid #22566d;
  border-radius: 6px;
  color: #cffafe;
  /* Each row's own text carries the ticket token, which is new every run and
   * would change the captured bytes. Show the row's name and place count
   * instead, both read from the row the organiser would click. */
  font-size: 0;
  padding: 0.5rem;
}

#ticket-options [role="option"]::before {
  content: attr(data-name) " (" attr(data-quantity) ")";
  font-size: 1rem;
}

#manual-checkin button[type="submit"] {
  background: var(--color-accent);
  border-color: #2f7188;
  border-radius: 6px;
  color: #e6f7fb;
  font-weight: 800;
  width: 100%;
}
`;

export const EVIDENCE_CAPTURES: EvidenceCaptureDeclaration[] = [
  v.parse(EvidenceCaptureDeclarationSchema, {
    caseId: "servicing.hold-on-dashboard",
    css: SERVICING_STUDIO_CSS,
    element: "#servicing-form",
    id: "servicing-studio-floor-hold",
    path: "/admin/servicing/{servicingEventId}",
    presentation: "branded",
    profiles: ["mobile"],
  }),
  v.parse(EvidenceCaptureDeclarationSchema, {
    caseId: "payments.select-saved-stripe",
    css: PAYMENT_PROVIDER_CSS,
    element: ".page-regions.admin-page",
    id: "payment-provider-choice",
    path: "/admin/settings",
    presentation: "branded",
    profiles: ["mobile"],
  }),
  v.parse(EvidenceCaptureDeclarationSchema, {
    caseId: "door.someone-still-to-arrive-can-be-picked",
    css: DOOR_CHECK_IN_CSS,
    element: "article:has(#manual-checkin)",
    id: "qr-code-check-in",
    path: "/admin/listing/{doorListingId}/scanner",
    presentation: "branded",
    profiles: ["mobile"],
  }),
];
