# Chobble Client Site Builder

Quick static site generator that combines the [Chobble Template](https://git.chobble.com/chobble/chobble-template/) with your content.

## Quick Start

1. **Add your content** - Edit markdown files and images in the relevant folders
2. **Push to GitHub** - The site builds automatically via GitHub Actions
3. **Deploy happens automatically** - Site deploys to Neocities (or your chosen host)

## What Goes Where

The `.pages.yml` defines all your content types:
- `pages/` - Static pages with navigation
- `news/` - Blog posts with dates
- `products/` - Shop items with prices and Etsy links
- `categories/` - Product categories
- `team/` - Team member profiles
- `reviews/` - Customer testimonials
- `events/` - Upcoming events
- `menus/`, `menu-categories/`, `menu-items/` - Restaurant menu system
- `snippets/` - Reusable content bits
- `images/` - All your images

## How It Works

When you push to GitHub:
1. GitHub Actions merges your content with the template
2. Builds the static site with Eleventy
3. Deploys to your configured hosting (Neocities by default)

## Configuration

Set these GitHub secrets for your repo:
- `NEOCITIES_API_KEY` - For deployment
- `FORMSPARK_ID` - For contact forms (optional)
- `BOTPOISON_PUBLIC_KEY` - For spam protection (optional)

## Local Development

Run `./bin/build` to build locally. The output appears in `result/`.