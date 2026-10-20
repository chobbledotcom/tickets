@story:pages.the-site-footer
@owner:pages @risk:low
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The site's footer
  The owner can write a footer for the site, and it shows at the bottom of
  the site's pages. Whatever the footer carries, a visitor reads it on every
  page that shows the footer — even on the page a visitor is shown when they
  ask for something that is not there.

  @rule:pages.the-footer-s-pictures-show-wherever-the-footer-shows
  @surface:public
  Rule: The footer's pictures show wherever the footer shows
    A picture the owner put in the footer shows on the site's pages, and on
    the page a visitor is shown when they ask for something that is not there.

    @case:site-footer.picture-on-the-front-page
    Scenario: The owner puts a picture in the footer
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the front page sees the picture in the footer

    @case:site-footer.picture-when-a-page-is-not-there
    Scenario: A visitor asks for a page that is not there
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor asking for a page nobody wrote still sees the picture in the footer
