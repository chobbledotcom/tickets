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

    @case:site-footer.picture-on-the-list
    Scenario: The footer's picture shows on the list
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the list sees the picture in the footer

    @case:site-footer.picture-on-the-contact-page
    Scenario: The footer's picture shows on the contact page
      Given the public site is on
      And the owner writes a contact page saying "Call the studio on market days."
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the contact page sees the picture in the footer

    @case:site-footer.picture-on-the-terms-page
    Scenario: The footer's picture shows on the terms page
      Given the public site is on
      And the owner writes the terms saying "Pay by Friday."
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the terms page sees the picture in the footer

    @case:site-footer.picture-on-the-order-page
    Scenario: The footer's picture shows on the order page
      Given the public site is on
      And the site sells a Pottery
      And the owner turns the order page on, introducing it with "Pick what you fancy."
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the order page sees the picture in the footer

    @case:site-footer.picture-on-the-news-page
    Scenario: The footer's picture shows on the news page
      Given the public site is on
      And the owner posts news called "Open Day" saying "Come along."
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the news page sees the picture in the footer

    @case:site-footer.picture-on-a-news-post
    Scenario: The footer's picture shows on a news post
      Given the public site is on
      And the owner posts news called "Open Day" saying "Come along."
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor following the "Open Day" post from the news page sees the picture in the footer

    @case:site-footer.picture-on-a-page-the-owner-wrote
    Scenario: The footer's picture shows on a page the owner wrote
      Given the public site is on
      And the owner has written a page called Sample at "sample"
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor reading "sample" sees the picture in the footer

    @case:site-footer.picture-on-a-booking-page
    Scenario: The footer's picture shows on a booking page
      Given the public site is on
      And the site sells a Concert
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the Concert's booking page sees the picture in the footer

    @case:site-footer.picture-on-the-ticket-a-customer-holds
    Scenario: The footer's picture shows on the ticket a customer holds
      Given the public site is on
      And the site sells a Pottery
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And Ada books 1 place on the Pottery
      Then a visitor opening the ticket they were given sees the picture in the footer

    @case:site-footer.picture-when-a-page-is-not-there
    Scenario: A visitor asks for a page that is not there
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor asking for a page nobody wrote is told the page does not exist
      And a visitor asking for a page nobody wrote still sees the picture in the footer

  @rule:pages.an-embedded-page-shows-no-footer
  @surface:public
  Rule: An embedded page shows no footer
    The organiser can put a booking page inside another website's page. The
    site keeps its footer out of that embedded page, because the website
    around it already carries its own words.

    @case:site-footer.no-footer-on-an-embedded-page
    Scenario: A visitor opens a booking page inside another website
      Given the public site is on
      And the site sells a Concert
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor opening the Concert's booking page inside another website sees no site footer
