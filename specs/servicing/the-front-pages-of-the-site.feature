@story:servicing.the-front-pages-of-the-site
@owner:servicing @risk:medium
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
@surface:admin
Feature: An owner writes the front pages of the site
  The public site opens on pages the owner writes themselves: the homepage
  that greets everyone, a contact page, and an order page that gathers
  everything bookable in one place. What the owner saves is what a visitor
  reads, and the order page stays off until the owner turns it on.

  @rule:servicing.the-homepage-says-what-the-owner-wrote
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

  @rule:servicing.the-contact-page-says-what-the-owner-wrote
  @surface:public
  Rule: The contact page says what the owner wrote
    The contact page carries the owner's own words about how to reach them.

    @case:front-pages.contact-read-back
    Scenario: The owner writes the contact page
      When the owner writes a contact page saying "Call the studio on market days."
      Then the owner is told the contact page saved
      And a visitor on the contact page reads "Call the studio on market days."

  @rule:servicing.the-order-page-is-off-until-turned-on
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
