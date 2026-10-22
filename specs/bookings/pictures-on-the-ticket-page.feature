@story:bookings.pictures-on-the-ticket-page
@owner:bookings @risk:medium
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A customer sees the images the owner put in the ticket page
  The owner writes the words the ticket page shows: what each thing is, the
  words a shared page carries, what a package includes, the terms, the site
  footer, and the questions. An image from the library can sit in any of
  those words.

  @rule:bookings.the-ticket-page-shows-the-image-a-reference-names
  @surface:public
  Rule: The ticket page shows the image a reference names
    The owner writes a short reference, and the page shows the image the
    library holds under that reference. When the library holds no image for
    a reference, the page shows the reference's name and no picture.

    @case:ticket-page.image-in-a-listing-description
    Scenario: The owner puts an image in what a thing is
      Given the owner has an image called Lighthouse in the library
      And the owner sells a Boat whose description carries the image Lighthouse
      Then a visitor reading the Boat's ticket page is shown the image Lighthouse

    @case:ticket-page.image-in-what-each-thing-is-on-one-page
    Scenario: The owner puts an image in what each thing is on a page that sells two things
      Given the owner has an image called Lighthouse in the library
      And the owner has an image called Peak in the library
      And the owner sells a Boat whose description carries the image Lighthouse
      And the owner sells a Cabin whose description carries the image Peak
      Then a visitor reading the page that sells the Boat and the Cabin is shown the image Lighthouse and the image Peak

    @case:ticket-page.image-in-the-group-description
    Scenario: The owner puts an image in a shared page's words
      Given the owner has an image called Coast in the library
      And the owner has a shared page called Afloat with the image Coast in its words
      And the Afloat page sells a Boat and a Cabin
      Then a visitor reading the Afloat page is shown the image Coast

    @case:ticket-page.image-in-a-package-description
    Scenario: The owner puts an image in what a package includes
      Given the owner has an image called Kit in the library
      And the owner sells a Hamper package holding a Tent
      And the Hamper package's description carries the image Kit
      And the Hamper package and a Torch sell from one page
      Then a visitor reading the page that offers the Hamper and the Torch is shown the image Kit in the package's description

    @case:ticket-page.image-in-what-an-included-thing-is
    Scenario: The owner puts an image in what an included thing is
      Given the owner has an image called Bedroll in the library
      And the owner sells a Hamper package holding a Tent
      And the Tent's description carries the image Bedroll
      And the Hamper package and a Torch sell from one page
      Then a visitor reading the page that offers the Hamper and the Torch is shown the image Bedroll in the Tent's row

    @case:ticket-page.image-in-the-terms
    Scenario: The owner puts an image in the terms
      Given the owner has an image called Rules in the library
      And the site's terms carry the image Rules
      And a Boat to book
      Then a visitor reading the Boat's ticket page is shown the image Rules

    @case:ticket-page.image-in-the-site-footer
    Scenario: The owner puts an image in the site footer
      Given the owner has an image called Beacon in the library
      And the site's footer carries the image Beacon
      And a Boat to book
      Then a visitor reading the Boat's ticket page is shown the image Beacon

    @case:ticket-page.image-in-the-site-footer-on-the-ticket
    Scenario: The customer sees the footer's image on their ticket
      Given the owner has an image called Beacon in the library
      And the site's footer carries the image Beacon
      And a Boat to book
      When Casey books 1 place on the Boat
      Then their ticket shows the image Beacon

    @case:ticket-page.image-in-a-question
    Scenario: The owner puts an image in a question
      Given the owner has an image called Poster in the library
      And a Boat to book
      And the owner asks the Boat's buyers a question with the image Poster in it
      Then a visitor reading the Boat's ticket page is shown the image Poster

    @case:ticket-page.image-on-the-ticket-itself
    Scenario: The customer sees the image on their ticket
      Given the owner has an image called Lighthouse in the library
      And the owner sells a Boat whose description carries the image Lighthouse
      When Casey books 1 place on the Boat
      Then their ticket shows the image Lighthouse

    @case:ticket-page.reference-no-image-answers
    Scenario: A reference the library cannot answer
      Given the owner has no images in the library
      And the owner sells a Boat whose description carries a reference to an image called Ghost
      Then a visitor reading the Boat's ticket page is shown Ghost's name and no picture
