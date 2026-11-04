@story:records.where-a-record-appears-elsewhere
@owner:records @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: Noting where a record appears in another system
  An organiser runs a second booking diary beside their ticket site. They note
  that a listing also appears in that diary, under the diary's own name, so
  staff can open the right entry from the listing. Only the organiser and their
  own tools read the notes.

  @rule:records.external-sources-answers-nothing-while-it-is-off
  @surface:admin
  Rule: External sources answers nothing while the owner has it off
    A site with External sources off gives the organiser's tool nothing to
    note, even for a diary the owner set up earlier.

    @case:records.a-note-refused-while-external-sources-is-off
    Scenario: The owner turns External sources off before the tool notes a listing
      Given the owner enables "External sources"
      And a diary called "Village diary"
      And a listing called "Watercolour day"
      And the owner disables "External sources"
      When the tool notes that "Watercolour day" is "EVT-1" in "Village diary"
      Then the tool is told to turn External sources on

  @rule:records.a-note-goes-when-its-record-goes
  @surface:admin
  Rule: A note goes when the record it names goes
    Deleting a listing deletes the notes that name it. Notes that name other
    listings stay.

    @case:records.deleting-a-listing-removes-its-notes
    Scenario: The owner deletes a listing noted in one diary
      Given the owner enables "External sources"
      And a diary called "Village diary"
      And a listing called "Watercolour day"
      And a listing called "Pottery day"
      And the owner has noted that "Watercolour day" is "EVT-1" in "Village diary"
      And the owner has noted that "Pottery day" is "EVT-2" in "Village diary"
      When the owner deletes "Watercolour day"
      Then "Village diary" no longer notes "Watercolour day"
      And "Village diary" still notes "Pottery day"

  @rule:records.asking-where-a-record-appears
  @surface:admin
  Rule: Asking where a listing appears answers from every diary
    The organiser's tool asks about one listing and is told each diary that
    holds it, by the diary's own name, in one answer.

    @case:records.a-listing-noted-in-two-diaries
    Scenario: A listing is noted in a diary and in the invoices
      Given the owner enables "External sources"
      And a listing called "Watercolour day"
      And a diary called "Village diary"
      And a diary called "Invoices"
      And the owner has noted that "Watercolour day" is "EVT-1" in "Village diary"
      And the owner has noted that "Watercolour day" is "INV-9" in "Invoices"
      When the tool asks where "Watercolour day" also appears
      Then the answer names "EVT-1" in "Village diary"
      And the answer names "INV-9" in "Invoices"
