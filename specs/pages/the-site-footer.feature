@story:pages.the-site-footer
@owner:pages @risk:low
@actor:organiser @actor:customer
@edition:managed @edition:self-hosted
Feature: The site's footer
  The owner can write a footer for the site, and it shows at the bottom of
  the site's pages. Whatever the footer carries, a visitor reads it on the
  front page, the list, the contact page, the terms page, the order page,
  the news page, a news post, a page the owner wrote, a booking page, and
  the ticket a customer holds. A visitor also reads it on the page the site
  shows when they ask for something that is not there.

  @rule:pages.the-footer-s-pictures-show-wherever-the-footer-shows
  @surface:public
  Rule: The footer's pictures show on the site's pages
    A picture the owner put in the footer shows on the front page, the list,
    the contact page, the terms page, the order page, the news page, a news
    post, a page the owner wrote, a booking page, and the ticket a customer
    holds — and on the page a visitor is shown when they ask for something
    that is not there. It also shows on the page a customer sees after they
    pay, the page they see after they book a free place, their payment link,
    their choices page, and the page they are shown when their checkout has
    ended or is still waiting.

    @case:site-footer.picture-on-the-front-page
    Scenario: The owner puts a picture in the footer
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the front page sees the picture in the footer

    @case:site-footer.picture-on-the-list
    Scenario: The footer's picture shows on the list
      Given the public site is on
      And the site sells a Pottery
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the list sees the Pottery and the picture in the footer

    @case:site-footer.picture-on-the-news-page
    Scenario: The footer's picture shows on the news page
      Given the public site is on
      And the owner has posted news called "Kiln opening"
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the news page reads "Kiln opening" and sees the picture in the footer

    @case:site-footer.picture-on-a-news-post
    Scenario: The footer's picture shows on a news post
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner posts news called "Kiln opening" saying "Doors open Friday."
      And the owner saves a site footer with the picture in it
      Then a visitor following "Kiln opening" from the news page reads "Doors open Friday." and sees the picture in the footer

    @case:site-footer.picture-on-the-ticket-a-customer-holds
    Scenario: The footer's picture shows on the ticket a customer holds
      Given the public site is on
      And the site sells a Pottery
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And Ada books 1 place on the Pottery
      Then a visitor opening the ticket they were given sees the picture in the footer

    @case:site-footer.picture-on-a-booking-page
    Scenario: The footer's picture shows on a booking page
      Given the public site is on
      And the site sells a Pottery
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor on the Pottery's booking page sees the picture in the footer

    @case:site-footer.picture-when-a-page-is-not-there
    Scenario: A visitor asks for a page that is not there
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      Then a visitor asking for a page nobody wrote is told the page does not exist
      And a visitor asking for a page nobody wrote still sees the picture in the footer

    Scenario Outline: The footer's picture shows beside the page's own words
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      And the owner has written the "<page>" with their own words
      When the owner saves a site footer with the picture in it
      Then a visitor on the "<page>" sees the picture in the footer

      Examples:
        | case_id                               | page                 |
        | site-footer.picture-on-contact        | contact page         |
        | site-footer.picture-on-terms          | terms page           |
        | site-footer.picture-on-order          | order page           |
        | site-footer.picture-on-a-written-page | page the owner wrote |

    @case:site-footer.picture-after-a-customer-pays
    Scenario: The footer's picture shows on the page a customer sees after they pay
      Given the public site is on
      And the site sells a Concert
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And Ada pays 15.00 for a place on the Concert
      Then the page they are shown after they pay says their order went through and shows the picture in the footer

    @case:site-footer.picture-after-a-free-booking
    Scenario: The footer's picture shows on the page a customer sees after they book a free place
      Given the public site is on
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And a customer books a free Free Meetup place
      Then the page their booking landed on shows the picture in the footer

    @case:site-footer.picture-on-the-payment-link
    Scenario: The footer's picture shows on a customer's payment link
      Given the public site is on
      And a customer owes 80.00 for a Retreat place
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And they pay a deposit of 30.00
      Then their payment link offers to take the 50.00 that is left
      And their payment link shows the picture in the footer

    @case:site-footer.picture-on-the-choices-page
    Scenario: The footer's picture shows on a customer's choices page
      Given the public site is on
      And the owner has an email provider of their own
      And 2 people have booked onto "the Gig"
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And the owner has sent a promotion to "the Gig" saying "Half price Friday."
      And one of them follows the choices link in their copy
      Then their choices page shows the picture in the footer

    @case:site-footer.picture-when-the-checkout-has-ended
    Scenario: The footer's picture shows when a customer's checkout has ended
      Given the public site is on
      And a customer's unpaid checkout has ended without a payment
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And the customer comes back to the checkout
      Then they are told the payment was cancelled
      And the page they were shown shows the picture in the footer

    @case:site-footer.picture-while-the-payment-still-waits
    Scenario: The footer's picture shows while the payment still waits
      Given the public site is on
      And a customer's checkout is still open and unpaid
      And the owner has uploaded a picture called "FooterPoster"
      When the owner saves a site footer with the picture in it
      And the customer comes back to the checkout
      Then they are asked to check again shortly
      And the page they were shown shows the picture in the footer

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
