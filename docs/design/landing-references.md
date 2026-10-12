# Landing page references

What premium US paid products do on their marketing pages, read on 2026-10-12,
and what ReelWalk's landing page takes from them. The page's rule is simple:
it is the editor's visual system (`apps/web/app/globals.css`) applied to a
long page, so a visitor who signs up lands in a product that looks like the
page that sold it.

## What we saw

**Linear (linear.app).** Near-black ground, one type family (Inter) at a
narrow band of weights, display sizes with hard negative tracking. Colour is
almost absent: one indigo, used only on CTAs and active states. Borders are
semi-transparent white, never solid dark lines; on a dark ground elevation
comes from a slightly lighter surface, not from a shadow, because dark-on-dark
shadows are invisible. Product UI is shown as real screenshots with a 1px
translucent border and 12px top radius, sitting directly on the ground.
Sections breathe at 80px+ on desktop, 48px on mobile. Pricing: four equal
columns, "$10 per user/month", "Billed yearly" as a quiet line under the
price, "Get started" on every plan, no "most popular" badge.

**Vercel (vercel.com, Geist).** Shadow-as-border (`0 0 0 1px`), three type
weights with strict roles (400 body, 500 UI, 600 headings), aggressive
tracking at display sizes, 80–120px between sections, pill CTAs. The product
is shown sparingly; whitespace carries the page.

**Descript (descript.com).** Six-figure logos first, then a five-step
workflow (Record, Edit, Refine, Share, Multiply) that mirrors the product's
own order. The CTA is one phrase, "Get started for free", repeated. Pricing
is on its own page with monthly/yearly prices side by side ("$16/user/month
billed annually or $24 billed monthly").

**Superhuman (superhuman.com).** Full-width product screenshots rather than
mockups; a single benefit in numbers ("Save 4+ hours each week"); CTAs are
plain verbs ("Get started", "Request a demo"). No pricing on the homepage.

**Arc (arc.net).** A cream canvas with one saturated blue used once per page
as a full-bleed band, then gone. Squircle radii (12–16px cards, 22px CTA),
borders rare, large soft shadows at 12% black. Browser captures do the work
and the chrome stays sparse.

**Runway, CapCut, Reelsy (ex-AutoReel).** Heavier pages: feature cards,
tabbed tool grids, user counts, testimonial carousels, four to five plans.
CapCut shows no device frames at all; Reelsy embeds short sample videos with
play buttons and lists plans in plain USD ("$29/month"). These read as
catalogues, not as one product.

**Real-estate media players (Roomvu, Aryeo, BoxBrownie).** All lead with the
work itself: calendars of posts, dashboards, before/after pairs. Aryeo's
pricing is on a separate page with a free tier named "Lite". BoxBrownie prices
per image. All three use "Get Started Free" wording and heavy social proof
(logos, "250K+ professionals").

## What we adopt

- **The product's own tokens, unaltered.** Ground `#0f2a44`, sunken surfaces
  `#0b2036`, raised controls `#163a5c`, text `#eaf2fb`, secondary `#9cb7d3`,
  sign red for Export-grade actions only. Linear's lesson applied: the page is
  dark because the editor is dark, and the mocks sit in it rather than on it.
- **Elevation by luminance, not shadow.** Phones have a `#061120` bezel with a
  1px translucent light ring; plan cards are the app's `.card` (sunken surface,
  lit 1px edge, 20px radius). The one shadow under a phone is large and soft.
- **One type family, a disciplined scale.** Archivo Variable only, the width
  axis doing the work the app already does with it: 125% wide at 800 for
  display, 112–118% for section heads, 100% for body. Display tracking tightens
  to −0.03em at 62px. No all-caps labels, no monospace labels, no eyebrows.
- **Colour restraint.** Red appears on the primary button, the step order
  badges (which are the app's own "tapped in this order" badge), the featured
  plan's edge, and inside the mocks where the app uses it. Bullets and link
  underlines use the drafting-blue rule, not red.
- **Spacing rhythm.** 56px between sections on a phone, 72–88px from 880px,
  hairline `--line` dividers that mark real section boundaries.
- **Pricing like Linear and Descript.** Three equal cards, "$X a month, $Y
  billed yearly", the monthly/yearly switch as a segmented pill using the
  app's chip states, "Start free" on every card. The featured plan is marked
  by its edge, not a badge.
- **The product shown as itself.** Real screens drawn in HTML with real rooms,
  finished reels in the hero. The order of the walkthrough is the order of the
  app's screens.
- **Plain-verb CTAs**, one phrase repeated: "Start free, no card".

## What we avoid

- Hype numbers, logo walls, testimonial carousels and star ratings we do not
  have. The page states only what is true of the product today.
- Decorative chrome from the editor: the blueprint grid on `<body>` is
  covered, there are no decorative timecodes or ruler marks outside the mocks.
- The SaaS card kit: only the plans are cards, because they are the only
  comparable items. Facts and questions are lists.
- Gradient washes as decoration. There is one radial light behind the hero's
  phones, the way a screen lights the desk under it, and nothing else.
- Entrance animations. The only motion is the first sample reel playing and
  button hover states; `prefers-reduced-motion` turns the latter off.
- Anything non-US: prices are in dollars, areas in sq ft, the sample listing
  is in Austin, TX, spelling is US.
