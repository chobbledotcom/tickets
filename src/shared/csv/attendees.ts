/**
 * Per-listing attendee CSV export. Always includes Email and Phone columns
 * regardless of listing settings; optionally prepends a Date column, listing
 * date/location columns, and one column per custom question.
 */

import { t } from "#i18n";
import {
  answerCols,
  attendeeCols,
  attendeeHeaders,
  buildCsv,
  type CsvListingInfo,
  type CsvQuestionData,
  csvDateRange,
  listingInfoCols,
  listingInfoHeaders,
} from "#shared/csv/attendee-columns.ts";
import { escapeCsvValue } from "#shared/csv/core.ts";
import type { Attendee } from "#shared/types.ts";

export type {
  CsvListingInfo,
  CsvQuestionData,
} from "#shared/csv/attendee-columns.ts";

/**
 * Generate CSV content from attendees.
 * When includeDate is true, adds a Date column for daily listings.
 * When listingInfo is provided, adds Listing Date and Listing Location columns.
 * When questionData is provided, adds columns for each custom question.
 */
export const generateAttendeesCsv = (
  attendees: Attendee[],
  includeDate = false,
  listingInfo?: CsvListingInfo,
  questionData?: CsvQuestionData,
): string => {
  const showListingDate = !!listingInfo?.listingDate;
  const showListingLocation = !!listingInfo?.listingLocation;
  const questions = questionData?.questions ?? [];
  const attendeeAnswerMap = questionData?.attendeeAnswerMap ?? new Map();

  // Build lookup from answer ID to answer text
  const answerTextMap = new Map<number, string>();
  for (const q of questions) {
    for (const a of q.answers) {
      answerTextMap.set(a.id, a.text);
    }
  }

  const questionHeaders = questions.map((q) => escapeCsvValue(q.text));
  const headerParts = [
    ...(includeDate ? [escapeCsvValue(t("common.date"))] : []),
    ...listingInfoHeaders(showListingDate, showListingLocation),
    ...attendeeHeaders(),
    ...questionHeaders,
  ];
  return buildCsv(
    headerParts.join(","),
    (a: Attendee, domain) => [
      ...(includeDate
        ? [escapeCsvValue(csvDateRange(a.date, a.end_date))]
        : []),
      ...listingInfoCols(
        showListingDate,
        showListingLocation,
        listingInfo?.listingDate ?? "",
        listingInfo?.listingLocation ?? "",
      ),
      ...attendeeCols(a, domain),
      ...answerCols(a.id, questions, attendeeAnswerMap, answerTextMap),
    ],
    attendees,
  );
};
