@story:attendees.images-in-admin-notes
@owner:attendees @risk:medium
@actor:organiser
@edition:managed @edition:self-hosted
Feature: The organiser reads notes that carry pictures
  A note can name a picture the organiser uploaded. Wherever the site writes
  that note out — beside the person, in the notes summary above a list, on the
  listing's own panels, or on the way to removing the note — the picture
  appears in place of the reference, and the reference itself is gone.

  @rule:attendees.a-picture-shows-wherever-the-note-is-read
  @surface:admin
  Rule: A picture in a note shows wherever the note is read
    Each place that shows the note shows the picture inside its own region. A
    picture seen anywhere on the page is not enough. On the person's page the
    note shows once, in the notes block in the page's top block above the
    tabs. Every summary holds its own copy.

    @case:images-in-notes.the-banner-and-the-notes-section-each-show-it
    Scenario: The organiser opens the person's page
      Given the organiser noted about Ada "Called about parking" with a picture called "Poster"
      When the organiser opens Ada's page
      Then the notes block above the tabs shows the "Poster" picture

    @case:images-in-notes.the-attendees-list-summary-shows-it
    Scenario: The organiser reads the notes summary on the Attendees page
      Given the organiser noted about Ada "Called about parking" with a picture called "Poster"
      When the organiser opens the Attendees page
      Then the notes summary shows the "Poster" picture

    @case:images-in-notes.the-listing-panels-show-it
    Scenario: The organiser reads the listing's overview and roster
      Given the organiser noted about Ada "Called about parking" with a picture called "Poster"
      When the organiser opens the Fayre's overview
      Then the notes summary shows the "Poster" picture
      When the organiser opens the Fayre's roster
      Then the notes summary shows the "Poster" picture

    @case:images-in-notes.the-delete-confirmation-shows-it
    Scenario: The organiser asks to remove the note
      Given the organiser noted about Ada "Remove me" with a picture called "Poster"
      When the organiser opens Ada's page
      And the organiser asks to remove that note
      Then the organiser is on the note's delete page
      And the confirmation shows the "Poster" picture
      And the confirmation never shows the picture reference
