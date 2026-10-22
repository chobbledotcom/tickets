@story:pages.the-front-pages-of-the-site
@owner:pages @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner writes the front pages of the site
  The public site opens on pages the owner writes themselves: the homepage
  that greets everyone, a contact page, and an order page that gathers
  everything bookable in one place. What the owner saves is what a visitor
  reads, and the order page stays off until the owner turns it on.

  @rule:pages.the-homepage-says-what-the-owner-wrote
  @surface:public
  Rule: The homepage says what the owner wrote
    The site's name and its welcome text both come from the homepage editor.
    Saving it is confirmed, and a visitor who was never signed in reads
    exactly those words on the front page.

    @case:front-pages.homepage-read-back
    Scenario: The owner writes the homepage
      When the owner writes a homepage called "Riverbank Pottery" saying "Classes for every age."
      Then the owner is told the homepage saved
      And a visitor on the front page reads "Riverbank Pottery"
      And a visitor on the front page reads "Classes for every age."

  @rule:pages.the-contact-page-says-what-the-owner-wrote
  @surface:public
  Rule: The contact page says what the owner wrote
    The contact page carries the owner's own words about how to reach them.

    @case:front-pages.contact-read-back
    Scenario: The owner writes the contact page
      When the owner writes a contact page saying "Call the studio on market days."
      Then the owner is told the contact page saved
      And a visitor on the contact page reads "Call the studio on market days."

  @rule:pages.the-order-page-is-off-until-turned-on
  @surface:public
  Rule: The order page is off until the owner turns it on
    Until the owner turns it on, asking for the order page finds nothing. Once
    it is on, visitors read the introduction the owner wrote above what is on
    sale.

    @case:front-pages.order-page-off-by-default
    Scenario: Nobody has turned the order page on
      Given the public site is on
      Then a visitor asking for the order page finds nothing there

    @case:front-pages.order-page-on-with-an-introduction
    Scenario: The owner turns the order page on
      Given the site sells a Pottery
      When the owner turns the order page on, introducing it with "Pick what you fancy."
      Then a visitor on the order page reads "Pick what you fancy."
      And a visitor on the order page reads "Pottery"

  @rule:pages.pictures-in-the-front-pages-show-as-pictures
  @surface:public
  Rule: Pictures in the front pages show as pictures
    The owner can place a picture they uploaded in the homepage text, the
    contact page, the terms, the order page's introduction, a group's words,
    or an item's description on the list. A visitor sees the picture itself,
    and never sees the reference that names it.

    @case:front-pages.homepage-picture
    Scenario: The owner puts a picture in the homepage
      Given the owner has uploaded a picture called "Riverbank"
      When the owner writes a homepage called "Riverbank Pottery" with the picture in it
      Then the owner is told the homepage saved
      And a visitor on the front page sees the picture

    @case:front-pages.contact-picture
    Scenario: The owner puts a picture in the contact page
      Given the owner has uploaded a picture called "StudioDoor"
      When the owner writes a contact page with the picture in it
      Then the owner is told the contact page saved
      And a visitor on the contact page sees the picture

    @case:front-pages.order-intro-picture
    Scenario: The owner puts a picture in the order page's introduction
      Given the site sells a Pottery
      And the owner has uploaded a picture called "PickPoster"
      When the owner turns the order page on, introducing it with the picture in it
      Then a visitor on the order page sees the picture

    @case:front-pages.terms-picture
    Scenario: The owner puts a picture in the terms
      Given the public site is on
      And the owner has uploaded a picture called "Rules"
      When the owner writes the terms with the picture in it
      Then the owner is told the terms saved
      And a visitor on the terms page sees the picture

    @case:front-pages.item-description-picture
    Scenario: The owner puts a picture in an item's description
      Given the public site is on
      And the owner has uploaded a picture called "Loom"
      When the site sells a Pottery with the picture in its description
      Then a visitor on the list reads the Pottery and sees the picture

    @case:front-pages.group-words-picture
    Scenario: The owner puts a picture in a group's words
      Given the public site is on
      And the owner has uploaded a picture called "FestivalMap"
      And a Festival group holding a Concert with the picture in its words
      When a customer looks at everything on sale
      Then the list offers the Festival
      And the list says the Festival is "Have a look."
      And a visitor on the list reads the Festival and sees the picture

    @case:front-pages.unknown-picture-keeps-its-describing-words
    Scenario: The homepage names a picture that is not there
      When the owner writes a homepage naming a picture that was never uploaded
      Then a visitor on the front page reads "Have a look."
      And the front page keeps the picture's describing words
      And the front page shows no picture at all
