import * as v from "valibot";
import {
  type EvidenceCaptureDeclaration,
  EvidenceCaptureDeclarationSchema,
} from "./schema.ts";

const SERVICING_STUDIO_CSS = `
:root {
  --border-radius: 5px;
  --color-accent: #c28b52;
  --color-bg: #e9edef;
  --color-bg-secondary: #d8e0e3;
  --color-link: #315b67;
  --color-secondary: #315b67;
  --color-secondary-accent: #315b6718;
  --color-shadow: #263f4724;
  --color-table: #315b67;
  --color-text: #27383d;
  --color-text-secondary: #66777c;
  --font-family: Arial, Helvetica, sans-serif;
}

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
];
