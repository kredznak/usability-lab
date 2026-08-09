# Review queue

89 findings await a human label. Set `human` to "true", "false" or
"unsure" in `fixtures/labelled/findings.json` (keyed by `key`); labels survive
`npm run corpus`.

The machine has already checked what it can: cited elements exist, quotes appear
on the page, measurements match. What it cannot judge is whether a true statement
is worth a founder's attention — that is the question below.

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f1

- **conversion-cta** · severity 3 · medium confidence · page-level
- https://www.allbirds.com/
- mechanical: **verified**

> Near the top of the page, before any product content, the text reads "Due to increased demand, orders may take up to 30 days to ship."

> Announcing a lengthy shipping delay before a visitor has seen any product or price sets a costly expectation early and may discourage continued browsing before any value has been demonstrated.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f2

- **a11y+heuristics** · severity 4 · high confidence · el_0
- https://www.allbirds.com/
- mechanical: **verified**

> Button at top of page is 24x24px with no visible text and no accessible name (also true of el_1 next to it).

> A screen reader announces this control only as "button" with no purpose, making it unusable without sighted guessing.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f3

- **conversion-cta** · severity 2 · high confidence · el_19
- https://www.allbirds.com/
- mechanical: **verified**

> The hero presents two equally weighted CTAs, "SHOP MEN" (el_19) and "SHOP WOMEN" (el_20), with no third option (e.g. "Shop All") given similar prominence.

> A visitor who has not yet decided on a category, or wants to browse broadly, has no equally prominent path forward and may leave rather than choose a side.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f4

- **forms** · severity 2 · high confidence · el_106
- https://www.allbirds.com/
- mechanical: **verified**

> A `<select>` element (el_106) in the footer lists a long run of country codes ("AE AT AU BE CA CH CN...") as its visible text, with only an aria-label of "Select country" to explain its purpose; no visible label or currently-selected value is distinguishable in the capture.

> A visitor scanning the page has no plain-language cue for what this control does or which country is currently selected, which can lead to accidental region/locale changes.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f6

- **a11y** · severity 2 · high confidence · el_6
- https://www.allbirds.com/
- mechanical: **verified**

> Nav buttons "Men" (30x16px) and "Sale" (31x16px, el_8) measure only 16px in height.

> Targets below roughly 24x24px are harder to activate accurately for visitors with motor impairments or imprecise pointer control.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f7

- **a11y** · severity 3 · high confidence · el_34
- https://www.allbirds.com/
- mechanical: **verified**

> Product image link (390x390px) has no accessible name, and this pattern repeats across all twelve product tiles (el_37, el_40, el_43, el_46, el_49, el_52, el_55, el_58, el_61, el_64, el_67).

> Screen reader users hit an unlabeled link before reaching the adjacent labelled product-name link, adding repeated noise across every product in the grid.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f8

- **a11y+forms** · severity 2 · high confidence · el_81
- https://www.allbirds.com/
- mechanical: **verified**

> The email field el_81 has no visible <label>; its only identifying text is the placeholder "Email Address", which is not present in the element's visible text/label list, meaning it exists solely as placeholder content.

> Once a visitor starts typing, the placeholder disappears and there is no persistent label to confirm what is being entered or to reference if the field is left blank on validation.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f10

- **conversion-cta** · severity 2 · high confidence · el_8
- https://www.allbirds.com/
- mechanical: **verified**

> The main navigation includes a "Sale" item (el_8), but no discount amount, sale scope, or end date is visible anywhere in the captured page.

> A sale link without any visible detail of the offer gives no reason to prioritize clicking it over other navigation items.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f11

- **conversion-cta** · severity 2 · high confidence · el_79
- https://www.allbirds.com/
- mechanical: **verified**

> The footer newsletter form is labeled "Subscribe to our emails" with a "Sign Up" button (el_80) and an email input (el_81), but no incentive (discount, early access, etc.) is stated anywhere near it.

> Asking for an email address with no stated benefit gives a visitor little reason to act, likely lowering signup rates.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f12

- **a11y** · severity 2 · high confidence · el_36
- https://www.allbirds.com/
- mechanical: **verified**

> Wishlist-style control is a <label> element with no visible text, deriving its name from a title attribute (e.g. "Women's Tree Runner NZ - Medium Grey (Blizzard Sole)"); the same pattern recurs on el_39 through el_69.

> Title-sourced names are not consistently exposed by assistive technology, and a bare <label> with no associated control may not be announced as interactive at all.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f14

- **heuristics** · severity 2 · high confidence · el_13
- https://www.allbirds.com/
- mechanical: **verified**

> The flyout menu items "Shop Womens", "Shop Mens", "Shop Socks", "Shop Women's Sale" and "Shop Men's Sale" (el_13-el_17) are implemented as <button> elements, while functionally identical category navigation elsewhere on the page, such as "Shop Men" (el_22) and "Shop Men" (el_71), are implemented as <a> elements.

> Using two different control types for the same kind of destination navigation is inconsistent and can produce different behavior (e.g. open-in-new-tab, drag, bookmarking) for what visitors experience as the same action.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f15

- **a11y** · severity 2 · high confidence · el_11
- https://www.allbirds.com/
- mechanical: **verified**

> An <h2> reading "Cart (0)" appears in the element order before the page's only <h1>, "Wildly Comfortable. Super Natural." (el_18).

> Screen reader users navigating by heading level encounter a level-2 heading before the top-level heading, which can misrepresent the page's structure when the cart panel is exposed to the accessibility tree.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f16

- **conversion-cta** · severity 1 · high confidence · el_77
- https://www.allbirds.com/
- mechanical: **verified**

> The "Fresh Colors For Summer" section offers only a single "Shop Women" link (el_77), unlike the other promotional sections which pair a men's and women's link.

> Breaking the established men's/women's pairing here may read as excluding male shoppers from that promotion, a small but avoidable drop-off point.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f17

- **heuristics** · severity 2 · high confidence · el_31
- https://www.allbirds.com/
- mechanical: **verified**

> Of four parallel section headings shown together ("New Arrivals" el_21, "Mens" el_24, "Womens" el_26, "Best Sellers" el_28), only "Best Sellers" is accompanied by an adjacent button element (el_31) with the same label.

> One section behaving differently from its structural siblings, without a visible reason, breaks the pattern a visitor has just learned from the other three sections.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f5

- **conversion-cta** · severity 1 · medium confidence · positive · page-level
- https://www.allbirds.com/
- mechanical: **verified**

> Each product tile in the grids displays its price plainly next to the name, e.g. "Women's Tree Runner NZ Medium Grey $100" and "Women's Canvas Cruiser Slip On Warm White $75".

> Showing price up front before a click lets visitors self-select by budget, reducing wasted clicks and building trust in the shopping experience.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f9

- **heuristics** · severity 1 · high confidence · positive · el_12
- https://www.allbirds.com/
- mechanical: **verified**

> The cart panel includes an explicit "Close cart" button (el_12) alongside a specific status message, "Spend $100 more to earn free shipping!", consistent with the stated empty cart total.

> A clear exit control paired with an accurate, actionable status message lets visitors dismiss the panel confidently and understand exactly what is needed to unlock free shipping.

**Question:** is this true, and is it worth showing someone?

## 1e6d5d13-638e-4d58-8b78-9aad1f68cb72:1e6d5d13-638e-4d58-8b78-9aad1f68cb72-f13

- **forms** · severity 1 · high confidence · positive · el_13
- https://www.allbirds.com/
- mechanical: **verified**

> The empty cart panel offers direct links back into shopping ("Shop Womens", "Shop Mens", "Shop Socks", "Shop Women's Sale", "Shop Men's Sale") rather than a dead end.

> Giving an explicit next step when the cart is empty keeps the visitor moving toward a purchase instead of having to re-navigate from scratch.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f1

- **a11y+heuristics** · severity 3 · high confidence · el_10
- https://www.gov.uk/
- mechanical: **contradicted** — says el_10 has no accessible name, but it is named "Show search menu" via aria-label

> A 61x61px <button> in the header region has no visible text and no accessible name recorded ('(no text)').

> Screen reader users encounter an unlabeled control with no indication of its purpose, making it impossible to know what activating it does.

**Question:** the check above says this contradicts the capture. Is the check right?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f2

- **a11y** · severity 2 · high confidence · el_22
- https://www.gov.uk/
- mechanical: **verified**

> Many text links throughout the page, e.g. "Childcare account: sign in" (el_22) and the repeated set in the footer (el_96–el_127), report a height of only 23px.

> Small interactive targets are harder to activate accurately for visitors with limited fine motor control or those using touch or switch input.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f3

- **a11y** · severity 2 · high confidence · el_12
- https://www.gov.uk/
- mechanical: **verified**

> The page's only <h1>, "The best place to find government services and information", is preceded in document order by two <h2> elements: "Cookies on GOV.UK" (el_0) and the visually hidden "Navigation menu" (el_8).

> Screen reader users who jump through headings to orient themselves on the page encounter subordinate headings before the main heading, adding friction to understanding page structure.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f4

- **a11y+heuristics** · severity 1 · high confidence · el_96
- https://www.gov.uk/
- mechanical: **verified**

> Identical link text, e.g. "Benefits" (el_26 and el_96), "News" (el_70 and el_114), and other category names, appears more than once on the page pointing into the same or related sections.

> Screen reader users browsing by a flat list of links rather than in visual context may struggle to distinguish which duplicate-named link goes where.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f5

- **copy** · severity 2 · high confidence · el_18
- https://www.gov.uk/
- mechanical: **verified**

> The link reads "HMRC account: sign in or set up" — the acronym HMRC is not expanded anywhere on the page.

> A visitor unfamiliar with UK government abbreviations cannot tell what this service is for without leaving the page to look it up.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f6

- **copy+heuristics** · severity 1 · high confidence · el_97
- https://www.gov.uk/
- mechanical: **verified**

> The footer link reads "Births, death, marriages and care" while the same category earlier on the page (el_27/el_28) reads "Births, deaths, marriages and care" — singular "death" versus plural "deaths."

> Inconsistent wording for the identical category signals a lack of proofreading and can make a visitor briefly wonder if these are two different sections.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f7

- **heuristics** · severity 1 · high confidence · el_0
- https://www.gov.uk/
- mechanical: **verified**

> The cookie banner ('Cookies on GOV.UK') offers 'Accept additional cookies' and 'Reject additional cookies' but no visible dismiss/close control to defer the decision.

> Visitors who want to explore the page first without committing to a cookie choice have no lightweight way to postpone the decision, which can feel like a forced interruption before reaching content.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f8

- **copy** · severity 2 · high confidence · el_12
- https://www.gov.uk/
- mechanical: **verified**

> The main heading reads "The best place to find government services and information."

> A superlative claim with no comparison point or evidence gives a first-time visitor nothing concrete to verify; it reads as marketing rather than a description of what the site actually contains.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f9

- **a11y** · severity 1 · high confidence · positive · el_14
- https://www.gov.uk/
- mechanical: **verified**

> The search field (el_15) has an associated <label> element (el_14) with visible text "Search", rather than relying on a placeholder for its name.

> A real, persistent label ensures the field's purpose remains available to assistive technology and sighted users even after text is entered, unlike a placeholder-only approach.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f10

- **a11y** · severity 1 · medium confidence · positive · page-level
- https://www.gov.uk/
- mechanical: **verified**

> All sampled links and buttons in the capture use descriptive, self-contained text such as "Check your State Pension forecast" and "Apply for a passport" rather than generic phrases like "click here" or "read more".

> Descriptive link text lets screen reader users understand a link's destination without needing surrounding context, which is a genuine accessibility strength across the page.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f11

- **heuristics** · severity 1 · high confidence · positive · el_17
- https://www.gov.uk/
- mechanical: **verified**

> A 'Popular on GOV.UK' section (el_17) surfaces six frequently needed destinations such as 'HMRC account: sign in or set up' and 'Check your State Pension forecast' directly above the fold.

> Surfacing high-frequency tasks near the top reduces the need for visitors to search or recall where a common service lives, which is good practice for a site with this many possible destinations.

**Question:** is this true, and is it worth showing someone?

## 45567cab-13a0-43ee-a021-da09973d769b:recovered-f12

- **copy** · severity 1 · medium confidence · positive · page-level
- https://www.gov.uk/
- mechanical: **contradicted** — quotes "Includes X, Y, Z", which is NOT on the page

> The category descriptions throughout "Services and information" (e.g. "Includes eligibility, appeals, tax credits and Universal Credit" for Benefits) consistently use short, concrete "Includes X, Y, Z" phrasing rather than abstract summaries.

> This consistent pattern across many categories makes the whole directory scannable, letting visitors self-select the right section quickly.

**Question:** the check above says this contradicts the capture. Is the check right?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f1

- **conversion-cta** · severity 3 · medium confidence · page-level
- https://www.allbirds.com/
- mechanical: **verified**

> The text "Due to increased demand, orders may take up to 30 days to ship." appears at the very top of the page, before any product or value proposition is shown.

> Disclosing a lengthy shipping delay before establishing product value or price gives a visitor a reason to hesitate before the page has made its case, which can suppress motivation to continue browsing.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f2

- **conversion-cta** · severity 2 · high confidence · el_82
- https://www.allbirds.com/
- mechanical: **verified**

> The only direct human-contact option visible in the capture is an email address, "help@allbirds.com", located in the footer alongside "FAQ/Contact Us".

> No phone number or live chat is visible anywhere above or below the fold, so a visitor with a pre-purchase question has only a slow channel available, which can stall a purchase decision.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f3

- **heuristics** · severity 2 · medium confidence · page-level
- https://www.allbirds.com/
- mechanical: **verified**

> The footer copyright line reads "©AB DNAM LLC 2026" while the brand shown everywhere else on the page is "Allbirds".

> A legal entity name that doesn't match the visible brand can read as inconsistent or, to a wary visitor, as a possible trust signal to double-check.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f4

- **conversion-cta** · severity 2 · high confidence · el_13
- https://www.allbirds.com/
- mechanical: **verified**

> Five carousel buttons of identical size (419x33px) — "Shop Womens", "Shop Mens", "Shop Socks", "Shop Women's Sale", "Shop Men's Sale" (el_13-el_17) — sit directly above the hero's own "SHOP MEN"/"SHOP WOMEN" buttons (el_19, el_20).

> Seven near-identical shopping CTAs stacked in the first screen give no single obvious next step, which can leave a visitor uncertain which path is the intended one.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f5

- **a11y+forms** · severity 3 · high confidence · el_36
- https://www.allbirds.com/
- mechanical: **verified**

> Repeated 24x24px <label> elements (el_36, el_39, el_42, el_45, el_48, el_51, el_54, el_57, el_60, el_63, el_66, el_69) sit next to each product tile but carry no visible or accessible text.

> A screen reader encountering these controls announces only 'label, unchecked' or similar with no indication of what the control does (likely wishlist or quick-add), making the feature unusable without sight.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f6

- **a11y** · severity 3 · high confidence · el_34
- https://www.allbirds.com/
- mechanical: **verified**

> Product image links (e.g. el_34, el_37, el_40, el_43, el_46, el_49, el_52, el_55, el_58, el_61, el_64, el_67), each 390x390px, have no accessible name or alt text listed, despite sitting adjacent to a separately-linked product title.

> Screen reader users hear an unlabeled link for every product image and must rely on a second, separate link to learn what the image was for, doubling navigation effort through a long product grid.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f7

- **a11y+heuristics** · severity 3 · high confidence · el_0
- https://www.allbirds.com/
- mechanical: **verified**

> Header icon controls el_0, el_1, el_9, el_10, and el_12 are buttons or links with no visible text and no accessible name recorded.

> These are likely search, account, and menu controls near the top of the page; without a name a screen reader user cannot tell what each one opens before activating it.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f8

- **a11y+forms+heuristics** · severity 2 · high confidence · el_106
- https://www.allbirds.com/
- mechanical: **verified**

> The footer select element (el_106) lists only two-letter country codes ("AE AT AU BE CA CH CN CZ DE DK EE EU FI FR IE IS IT JP KR KW LI LT LU LV MT MY NL NO NZ PH PL SA SE SG SM UK US") with no visible label such as "Country" or "Ship to" next to it.

> Visitors cannot tell from the control itself what selecting a value will change (currency, region, shipping), which can cause hesitation or an unintended region switch.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f9

- **a11y+forms** · severity 2 · high confidence · el_81
- https://www.allbirds.com/
- mechanical: **verified**

> The email input in the newsletter signup form (el_79) carries no visible text of its own; the only nearby label-like text is the section heading "Subscribe to our emails" and the button text "Sign Up".

> If the field relies on placeholder text that clears on focus, visitors who look away mid-entry lose the cue for what the field expects, which can lead to abandoned or mis-filled submissions.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f10

- **conversion-cta** · severity 2 · high confidence · el_80
- https://www.allbirds.com/
- mechanical: **verified**

> The newsletter form's submit button reads only "Sign Up" with no accompanying text stating what a subscriber receives (e.g. a discount or early access).

> A generic label with no stated benefit gives little reason to trade an email address, likely lowering signups.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f11

- **conversion-cta** · severity 2 · high confidence · el_19
- https://www.allbirds.com/
- mechanical: **verified**

> The hero CTAs read only "SHOP MEN" / "SHOP WOMEN" with no supporting text on what happens next (e.g. browsing a catalog vs. a curated collection).

> A visitor cannot tell from the button alone whether clicking leads to a full catalog, a single collection, or a filtered subset, adding a small amount of uncertainty before commitment.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f12

- **a11y+heuristics** · severity 2 · high confidence · el_74
- https://www.allbirds.com/
- mechanical: **verified**

> Multiple links across the page repeat the identical text 'Shop Men' and 'Shop Women' (e.g. el_22, el_25, el_29, el_71, el_74 all say 'Shop Men'; el_23, el_27, el_30, el_72, el_75, el_77 all say 'Shop Women').

> A screen reader user browsing by a links list hears the same phrase many times with no distinguishing context, making it hard to tell which link corresponds to which product section already passed.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f13

- **a11y** · severity 2 · high confidence · el_100
- https://www.allbirds.com/
- mechanical: **contradicted** — says el_100 has no accessible name, but it is named "Instagram" via aria-label

> The six social-media links in the 'Follow The Flock' footer section (el_100–el_105) are 42x42px with no accessible text.

> Screen reader users get a list of six identical unlabeled links and cannot tell which platform each one leads to without guessing from icon shape alone.

**Question:** the check above says this contradicts the capture. Is the check right?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f14

- **a11y** · severity 2 · high confidence · el_32
- https://www.allbirds.com/
- mechanical: **contradicted** — says el_32 has no accessible name, but it is named "Previous Product" via title

> Carousel navigation buttons el_32 and el_33 (40x40px) below the 'Best Sellers' heading have no accessible name.

> A keyboard or screen reader user reaching these controls cannot tell which one advances versus goes back through the product carousel.

**Question:** the check above says this contradicts the capture. Is the check right?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f15

- **conversion-cta** · severity 1 · high confidence · positive · el_35
- https://www.allbirds.com/
- mechanical: **verified**

> Product entries show price directly beside the product name, e.g. "Women's Tree Runner NZ Medium Grey $100".

> Plain, upfront pricing removes a common point of hesitation before a visitor commits to viewing or purchasing a product.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f16

- **conversion-cta+heuristics** · severity 1 · medium confidence · positive · page-level
- https://www.allbirds.com/
- mechanical: **verified**

> The visible text includes "Spend $100 more to earn free shipping!" tied to the (empty) cart state.

> A concrete, quantified incentive gives a visitor a reason to add more to cart, though it is only visible once a cart is opened rather than earlier in the browsing path.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f17

- **forms** · severity 1 · high confidence · positive · el_79
- https://www.allbirds.com/
- mechanical: **verified**

> The only text-entry form visible in this capture, el_79, asks for a single input (el_81) before the "Sign Up" button (el_80) can be submitted.

> Asking for just one piece of information keeps the newsletter signup low-friction and reduces a common source of drop-off seen in longer forms.

**Question:** is this true, and is it worth showing someone?

## 6415e068-08ea-4820-8bcb-aa5644f0a32b:recovered-f18

- **a11y** · severity 1 · high confidence · positive · el_18
- https://www.allbirds.com/
- mechanical: **verified**

> The page has a single <h1> ('Wildly Comfortable. Super Natural.') followed by <h2> section headings (New Arrivals, Mens, Womens, Best Sellers, Summer Travel Essentials, Fresh Colors For Summer) and a <h3> ('Follow The Flock') in the footer, with no level skipped in the captured structure.

> A logical, non-skipping heading outline lets screen reader users jump between sections confidently using heading navigation.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f1

- **conversion-cta** · severity 3 · high confidence · el_137
- https://linear.app/
- mechanical: **verified**

> The most prominent styled call-to-action buttons, "Get started" (el_137) and "Contact sales" (el_138), appear only near the bottom of a page that is 10,898px tall. Above the fold, the only comparable action is "Sign up" (el_10), a plain text link in the header nav.

> A visitor who scrolls through the extensive feature walkthrough (Intake, Plan, Build, Diffs, Monitor sections) has no reinforced action to take until the very end, increasing the chance they lose momentum or leave before converting.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f2

- **copy+heuristics** · severity 2 · high confidence · el_11
- https://linear.app/
- mechanical: **verified**

> The H1 text is rendered twice in sequence: "The product development system for teams and agents The product development system for teams and agents".

> A visitor scanning the hero sees the same sentence repeated, which reads as a content error and undercuts confidence in the page before any claim is even evaluated.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f3

- **copy** · severity 2 · medium confidence · page-level
- https://linear.app/
- mechanical: **verified**

> The subheadline text reads "Purpose-built for planning and building products. Designed for the AI era."

> "Designed for the AI era" is a phrase with no concrete referent — it does not say what the product does differently — so it adds length without adding understanding for a first-time reader.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f4

- **copy** · severity 2 · high confidence · el_50
- https://linear.app/
- mechanical: **verified**

> The section heading reads "A new species of product tool." followed by "Purpose-built for modern teams with AI workflows at its core, Linear sets a new standard for planning and building products."

> "New species" and "sets a new standard" are not concrete claims; a first-time visitor has no way to verify or picture what specifically is different, which weakens the section's ability to explain the product.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f5

- **conversion-cta** · severity 3 · high confidence · el_6
- https://linear.app/
- mechanical: **verified**

> "Pricing" (el_6) exists only as a nav link; no price, plan tier, or cost figure appears anywhere in the captured page text.

> Visitors deciding whether to commit typically look for a plain answer on cost before acting; requiring an extra click to even see pricing can cost conversions from price-sensitive visitors.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f6

- **conversion-cta** · severity 2 · high confidence · el_12
- https://linear.app/
- mechanical: **verified**

> "New Coding Sessions →" (el_12) is styled and positioned like an action link directly beneath the hero headline, but its text describes a feature name rather than an action or outcome.

> A visitor scanning the hero for what to do next may be uncertain whether this link leads to a feature demo, documentation, or the product itself.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f7

- **conversion-cta** · severity 2 · high confidence · el_10
- https://linear.app/
- mechanical: **verified**

> "Log in" (el_9) and "Sign up" (el_10) are both presented as plain nav-level text links of the same style and size.

> Without differentiation, a first-time visitor has no cue about which action is intended for them, diluting the pull toward the new-visitor conversion action.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f8

- **conversion-cta** · severity 2 · high confidence · el_137
- https://linear.app/
- mechanical: **verified**

> The bottom CTA reads simply "Get started" with no indication of what follows — a signup form, a free trial, a credit-card request, or a demo.

> Vague action labels leave visitors uncertain about the size of the commitment before they click, which can suppress click-through from cautious visitors.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f9

- **forms+heuristics** · severity 2 · high confidence · el_121
- https://linear.app/
- mechanical: **verified**

> Elements styled as live product UI - a "Listen" button, a "1.0×" speed combobox (el_122), a command-menu input (el_105), and large empty textareas (el_40, el_115) - are embedded in what is otherwise static marketing content.

> Presenting interactive-looking controls that are actually illustrative mockups can lead visitors to expect real functionality, and any resulting non-response undermines trust in the product being demonstrated.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f10

- **heuristics** · severity 3 · high confidence · el_15
- https://linear.app/
- mechanical: **verified**

> Dozens of buttons across the page (e.g. el_15, el_16, el_31-el_34, el_37-el_39, el_41-el_46, el_53-el_76, el_78-el_87) carry no visible text label, only "(no text)" in the capture, meaning they rely on icon-only recognition.

> Visitors cannot tell what these controls do without hovering or guessing, which slows scanning of an already very long page and can mask non-functional decorative elements as actionable ones.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f11

- **copy** · severity 2 · high confidence · el_108
- https://linear.app/
- mechanical: **verified**

> The button reads "3.3 Linear MCP +" with no expansion of the acronym "MCP" anywhere in the surrounding captured text.

> Visitors unfamiliar with "Model Context Protocol" style acronyms cannot tell what this feature does from the label alone, forcing them to guess or skip it.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f12

- **conversion-cta** · severity 1 · high confidence · positive · el_133
- https://linear.app/
- mechanical: **verified**

> Testimonials are attributed to named, verifiable individuals with job titles and companies, e.g. "Gabriel Peal Staff Software Engineer, OpenAI" (el_133) and "Nik Koblov Head of Engineering, Ramp" (el_134).

> Specific, attributed social proof of this kind is a credible trust signal that can support a visitor's decision to proceed.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f13

- **heuristics** · severity 1 · high confidence · positive · el_52
- https://linear.app/
- mechanical: **verified**

> Major sections are consistently numbered and labeled as a sequence: "1.0Intake→", "2.0Plan→", "3.0Build→", "4.0Diffs→", "5.0Monitor→".

> This consistent numbering gives visitors a repeatable mental model of the product's workflow stages as they scroll through a long page, aiding orientation.

**Question:** is this true, and is it worth showing someone?

## 9664f4c2-2038-48f6-9b8a-f873eaec2534:recovered-f14

- **copy** · severity 1 · high confidence · positive · el_128
- https://linear.app/
- mechanical: **verified**

> The changelog entry reads "Coding sessions on mobile Your coding session doesn't have to stop when you leave your desk. Use the Linear mobile app to review code changes, comment on specific lines, and iterate with Linear Agent."

> This entry states a specific, concrete benefit (reviewing code on mobile) in plain, visitor-facing language, giving readers something they can picture and act on.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f1

- **copy** · severity 2 · high confidence · el_11
- https://linear.app/
- mechanical: **verified**

> The hero heading reads "The product development system for teams and agents." The term "agents" is used without any definition on the first screen; the supporting line below is "Purpose-built for planning and building products. Designed for the AI era."

> A first-time visitor unfamiliar with the product may not know what "agents" refers to (AI agents vs. human agents/support reps) until scrolling much further down the page.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f2

- **conversion-cta** · severity 3 · medium confidence · page-level
- https://linear.app/
- mechanical: **verified**

> The page runs roughly 10,900px tall with an extended interactive product walkthrough (issue trackers, roadmaps, agent chat, code diffs, dashboards) between the top CTA "New Coding Sessions →" and the next explicit action CTAs "Get started" / "Contact sales" near the very bottom.

> Visitors who scroll through the lengthy product demonstration have no reinforcing call to action to act on along the way, so interest built up during the walkthrough has no nearby outlet.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f3

- **conversion-cta** · severity 2 · high confidence · el_12
- https://linear.app/
- mechanical: **verified**

> The hero call to action reads "New Coding Sessions →", a label tied to one specific product feature rather than a general next step like signing up or starting a trial.

> A visitor arriving from the headline "The product development system for teams and agents" has no way to tell if clicking commits them to sign-up, opens a demo, or requires an existing account, which can stall the very first action on the page.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f4

- **heuristics** · severity 3 · high confidence · el_105
- https://linear.app/
- mechanical: **verified**

> The page embeds apparently-interactive controls inside a static demonstration: a combobox (el_105), a code-filled textarea (el_115), a "Listen" button (el_121), and a playback-speed selector "1.0×" (el_122).

> Visitors may try to type into the field, press Listen, or change the speed expecting a real response, since nothing distinguishes these from live functionality, and receive none.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f5

- **conversion-cta** · severity 2 · high confidence · el_10
- https://linear.app/
- mechanical: **verified**

> Above the fold, the header offers "Sign up" while the hero also offers "New Coding Sessions →" as a separate, differently-labeled action.

> Two above-the-fold actions with different labels and no visual hierarchy cue as to which is primary can split attention and slow the decision to act.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f6

- **copy** · severity 2 · high confidence · el_92
- https://linear.app/
- mechanical: **verified**

> The copy under "Define the product direction" reads "Align your team with product initiatives, strategic roadmaps, and clear, up-to-date PRDs." The acronym "PRDs" is not expanded anywhere on the page.

> Visitors outside product-management roles may not recognize "PRDs" (product requirements documents), which can stall comprehension of what the feature actually does.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f7

- **copy** · severity 2 · high confidence · el_50
- https://linear.app/
- mechanical: **verified**

> The section heading reads "A new species of product tool." followed by "Purpose-built for modern teams with AI workflows at its core, Linear sets a new standard for planning and building products."

> "A new species" and "sets a new standard" are abstract superlatives with no concrete referent or evidence, which can read as marketing filler rather than information a visitor can evaluate.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f8

- **visual-hierarchy** · severity 3 · high confidence · el_50
- https://linear.app/
- mechanical: **verified**

> The page's single h1, "The product development system for teams and agents," measures 1282x128px, but a later h2, "A new species of product tool. Purpose-built for modern teams with AI workflows at its core, Linear sets a new standard for planning and building products," measures 1250x144px — 16px taller than the h1. A further h2, "Built for the future. Available today." (el_136), measures 722x144px, also exceeding the h1's height.

> When a subordinate heading is rendered larger than the page's only h1, the size cue that should mark the single most important statement is undermined, and a visitor scanning by size alone may land on the wrong sentence first.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f9

- **conversion-cta** · severity 2 · high confidence · el_6
- https://linear.app/
- mechanical: **verified**

> "Pricing" appears only as a top navigation link; no price, plan tiers, or cost figures are present anywhere in the captured page text.

> Visitors weighing whether to sign up cannot see cost or commitment level without leaving the page, which adds friction before the decision to act.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f10

- **conversion-cta** · severity 2 · high confidence · el_137
- https://linear.app/
- mechanical: **verified**

> The closing CTA is labeled simply "Get started" with no indication of what happens next (free trial, account creation, demo request).

> A visitor who has just been convinced by the surrounding content still has to guess what committing to "Get started" actually involves.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f11

- **conversion-cta** · severity 2 · high confidence · el_133
- https://linear.app/
- mechanical: **verified**

> Customer testimonials ("You'll probably build a better product, just because of the craft that using Linear infuses on your brain." — Gabriel Peal, OpenAI) sit far below the fold, only after the full product walkthrough section.

> Social proof is not visible near the top-of-page CTA, so the first decision to act happens without the credibility signal that testimonials would provide.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f12

- **heuristics** · severity 2 · high confidence · el_31
- https://linear.app/
- mechanical: **verified**

> Dozens of buttons throughout the embedded product demo render as bare 20-32px squares with no visible text label, e.g. el_31, el_37, el_53 through el_76, el_78 through el_87.

> Visitors must guess each control's function from an icon alone, which raises cognitive load, especially since the pattern repeats dozens of times down the page.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f13

- **visual-hierarchy** · severity 2 · high confidence · el_137
- https://linear.app/
- mechanical: **verified**

> "Get started" (el_137, 127x44px) and "Contact sales" (el_138, 144x44px) sit side by side with identical height and only a 17px width difference.

> With near-equal size, neither action is visually established as the primary path forward at the point where a visitor is deciding what to do next.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f14

- **copy** · severity 1 · high confidence · positive · el_51
- https://linear.app/
- mechanical: **verified**

> The section "Make product operations self-driving" is immediately followed by "Turn conversations and customer feedback into actionable issues that are routed, labeled, and prioritized for the right team."

> Pairing an abstract heading with a concrete, step-by-step explanation lets a visitor quickly understand what the feature actually does, which supports comprehension.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f15

- **heuristics+visual-hierarchy** · severity 1 · high confidence · positive · el_52
- https://linear.app/
- mechanical: **verified**

> The five product-stage sections follow a uniform "N.0 Label →" pattern: "1.0 Intake →", "2.0 Plan →", "3.0 Build →", "4.0 Diffs →", "5.0 Monitor →".

> The repeated numbering and arrow convention gives visitors a predictable structure to follow through a very long page, reducing disorientation.

**Question:** is this true, and is it worth showing someone?

## c44b7d32-c004-4005-b7f4-fb059df063b9:recovered-f16

- **conversion-cta** · severity 1 · high confidence · positive · el_137
- https://linear.app/
- mechanical: **verified**

> Near the bottom, two CTAs sit side by side: "Get started" and "Contact sales", offering separate paths for self-serve versus sales-assisted visitors.

> Separating self-serve and enterprise intents lets each visitor type find an appropriately-sized commitment, which research suggests can reduce mismatched drop-off.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f1

- **a11y+heuristics** · severity 2 · high confidence · el_70
- https://www.gov.uk/
- mechanical: **verified**

> Short link labels such as "News" (el_70) and "Benefits" (el_26) are repeated verbatim elsewhere on the page (el_114, el_96) with no distinguishing text, relying only on an adjacent heading for context.

> When a screen reader user pulls up a page-wide list of links (a common navigation strategy), several identically-worded links with no differentiating text make it hard to tell which destination is which.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f2

- **a11y** · severity 2 · high confidence · el_0
- https://www.gov.uk/
- mechanical: **verified**

> The heading order on the page starts with two <h2> elements — "Cookies on GOV.UK" (el_0) and the visually hidden "Navigation menu" (el_8) — both appearing before the page's only <h1>, "The best place to find government services and information" (el_12).

> Screen reader users who jump by heading level encounter h2s before any h1, breaking the expected top-down hierarchy and making the page's主 structure harder to predict.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f3

- **copy** · severity 2 · high confidence · el_18
- https://www.gov.uk/
- mechanical: **verified**

> The link text reads "HMRC account: sign in or set up" with no expansion of the acronym "HMRC" anywhere nearby.

> Visitors unfamiliar with UK government abbreviations may not recognise what this account relates to and could skip a relevant link.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f4

- **heuristics** · severity 2 · high confidence · el_0
- https://www.gov.uk/
- mechanical: **verified**

> The cookie banner (el_0) offers only "Accept additional cookies" (el_1), "Reject additional cookies" (el_2) and "View cookies" (el_3); there is no visible option to close or dismiss the banner without making one of these choices.

> Visitors who want to proceed straight to the page content are required to engage with the cookie prompt first, adding a forced step before any other action.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f5

- **heuristics** · severity 2 · high confidence · el_97
- https://www.gov.uk/
- mechanical: **verified**

> The main content list names a category "Births, deaths, marriages and care" (el_28), but the footer link for the same category reads "Births, death, marriages and care" (el_97). Similarly, "Transparency documents" (el_77) in the main list becomes just "Transparency" (el_118) in the footer.

> Slightly different labels for links that lead to the same destination can make visitors unsure whether the two entries point to the same content, adding a small amount of doubt to navigation decisions.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f6

- **copy** · severity 2 · high confidence · el_128
- https://www.gov.uk/
- mechanical: **verified**

> The footer link reads "Rhestr o Wasanaethau Cymraeg" with no English translation or label indicating it is a Welsh-language services list.

> English-only readers cannot tell what this link leads to, and Welsh-speaking visitors get no visual cue distinguishing it from other footer links.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f7

- **heuristics** · severity 1 · high confidence · el_10
- https://www.gov.uk/
- mechanical: **verified**

> The navigation toggle (el_9) displays a visible text label "Menu", while the adjacent search toggle (el_10) shows no visible text at all, relying only on an icon with accessible name "Show search menu".

> Inconsistent treatment of two adjacent header controls, one labelled with text and one icon-only, can make the function of the unlabelled control less immediately obvious when scanning the header.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f8

- **a11y** · severity 1 · high confidence · positive · el_15
- https://www.gov.uk/
- mechanical: **verified**

> The search combobox (el_15) has its accessible name sourced from an associated <label> element (el_14, text "Search") rather than from a placeholder attribute.

> Because the label is a true <label>, the field's name persists for assistive technology users even once text is typed, unlike a placeholder-only label which disappears on input.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f9

- **copy** · severity 1 · high confidence · positive · el_12
- https://www.gov.uk/
- mechanical: **verified**

> The h1 reads "The best place to find government services and information", stating plainly what the site is and does.

> A visitor who has never heard of GOV.UK can grasp the site's purpose in a single sentence, reducing early confusion.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f10

- **copy** · severity 1 · high confidence · positive · el_25
- https://www.gov.uk/
- mechanical: **verified**

> Category descriptions follow a consistent, concrete pattern, e.g. "Includes eligibility, appeals, tax credits and Universal Credit" under "Benefits", giving a specific scope for each topic rather than vague summary language.

> Consistent, concrete descriptions help visitors scan and self-select the right category quickly.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f11

- **a11y** · severity 1 · high confidence · positive · el_10
- https://www.gov.uk/
- mechanical: **verified**

> The icon-only button with no visible text is given an accessible name via aria-label="Show search menu".

> Screen reader and voice-control users get a clear, actionable name for a control that would otherwise be silent, so the control remains usable.

**Question:** is this true, and is it worth showing someone?

## dfcd777a-2bb6-4681-8d30-0c07769c9531:recovered-f12

- **heuristics** · severity 1 · high confidence · positive · el_2
- https://www.gov.uk/
- mechanical: **verified**

> "Accept additional cookies" (el_1, 235x38px) and "Reject additional cookies" (el_2, 229x38px) are presented as two buttons of near-identical size and prominence, side by side.

> Giving the reject option equal visual weight to accept respects visitor choice and avoids steering consent through design bias, which supports trust in the site.

**Question:** is this true, and is it worth showing someone?
