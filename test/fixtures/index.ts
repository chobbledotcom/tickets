/**
 * Test fixtures loader
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const loadFixture = (name: string): string =>
  readFileSync(join(__dirname, name), "utf-8");

export const tagPageHtml = loadFixture("tag-page.html");
export const reportPageHtml = loadFixture("report-page.html");

export const minimalReportHtml = `
  <h1>Inspection Report 123-v1</h1>
  <div class="badge badge--green">Pass</div>
`;

export const tagPageNoReportsHtml = `
  <div class="check__image-tag check__image-tag--green">Pass</div>
  <div class="check__details">
    <div class="color--blue">Unit Reference No:</div>
    <div class="color--dark-blue">12345</div>
  </div>
  <div class="y-spacer"></div>
`;
