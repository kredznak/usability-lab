import { ALL_RUBRICS } from "./agents/rubrics.js";
import type { Citation } from "./types.js";

/**
 * The evidence corpus — docs/design.md §5's `corpus_query`, as a checked-in
 * table rather than a database. Twenty-two rows do not need Postgres.
 *
 * ## Why the model never writes a URL
 *
 * quality-bar.md is unambiguous: a fabricated citation "is the worst single
 * output this product can produce, worse than no audit." The catalogue answers
 * that with F5 — lint the URL, strip it if it does not resolve. We answer it
 * earlier: the Research agent has no URL field to write into. It names a source,
 * and `resolveCitation` reads the URL from this table. A URL the model invented
 * has nowhere to go.
 *
 * The id it names is *not* structurally constrained — this SDK compiles a zod
 * enum to a description rather than a JSON Schema enum (pinned in
 * sources.test.ts). So the id is validated on arrival, not trusted. An id we do
 * not hold becomes `none`.
 *
 * This is the lesson from `src/claims.ts` and the severity schema, applied
 * where it costs most: a constraint written into a prompt is a request, and a
 * constraint written into a lookup is a fact.
 *
 * ## What a row promises
 *
 * `claim` is what the page actually says, checked by reading it — not a summary
 * of what we wish it said. Every URL here was fetched and the claim confirmed
 * against the page — the original fifteen on 2026-08-13, the seven added
 * against measured gaps on 2026-08-19. When a row cannot be confirmed it does not
 * go in; `source_type: "none"` is always legal and always better than a guess.
 *
 * `topics` is the list of rubrics a source may legitimately support. It exists
 * so the Research agent is shown a shortlist rather than the whole table, and
 * so a WCAG criterion cannot end up attached to a copy finding.
 */

export type SourceTopic = (typeof ALL_RUBRICS)[number]["id"];

export interface Source {
  id: string;
  title: string;
  publisher: string;
  url: string;
  /** Rubric ids this source can legitimately support. */
  topics: SourceTopic[];
  /** What the page actually says. Verified by reading it, not recalled. */
  claim: string;
  /** §9's citation enum. Everything here is published research or guidance. */
  source_type: "paper" | "competitor";
}

export const SOURCES: Source[] = [
  // ---- Nielsen Norman Group ----
  {
    id: "nng-ten-heuristics",
    title: "10 Usability Heuristics for User Interface Design",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/ten-usability-heuristics/",
    topics: ["heuristics", "forms", "conversion-cta"],
    claim:
      "Jakob Nielsen's ten general principles for interaction design, including visibility of system status (\"The design should always keep users informed about what is going on, through appropriate feedback within a reasonable amount of time\") and recognition rather than recall.",
    source_type: "paper",
  },
  {
    id: "nng-placeholders-harmful",
    title: "Placeholders in Form Fields Are Harmful",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/form-design-placeholders/",
    topics: ["forms", "a11y", "copy"],
    claim:
      "Replacing field labels with in-field placeholder text has many negative consequences; the best solution is clear, visible labels placed outside empty form fields, always visible to the user. (Katie Sherwin, 2014, reviewed 2018.)",
    source_type: "paper",
  },
  {
    id: "nng-error-messages",
    title: "Error-Message Guidelines",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/error-message-guidelines/",
    topics: ["forms", "copy", "heuristics"],
    claim:
      "Error messages should appear adjacent to where the error occurred, use noticeable redundant indicators, use human-readable language rather than jargon, describe the problem specifically, offer constructive advice, and preserve the user's original input. (Neusesser & Sunwall, 2023.)",
    source_type: "paper",
  },
  {
    id: "nng-users-scan",
    title: "How Users Read on the Web",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/how-users-read-on-the-web/",
    topics: ["copy", "visual-hierarchy"],
    claim:
      "People rarely read web pages word by word; they scan, picking out individual words and sentences. In the study 79% of test users scanned new pages and only 16% read word by word. (Jakob Nielsen, 1997 — old, and still the canonical statement of the finding.)",
    source_type: "paper",
  },
  {
    id: "nng-f-pattern",
    title: "F-Shaped Pattern of Reading on the Web: Misunderstood, But Still Relevant",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/",
    topics: ["visual-hierarchy", "copy"],
    claim:
      "Scanning does not always take the shape of an F — there are other common patterns — but F-shaped scanning is bad for users and businesses, and good design (headings, formatting, front-loaded content) can prevent it. (Kara Pernice.)",
    source_type: "paper",
  },

  // ---- Baymard Institute ----
  {
    id: "baymard-cart-abandonment",
    title: "50 Cart Abandonment Rate Statistics",
    publisher: "Baymard Institute",
    url: "https://baymard.com/lists/cart-abandonment-rate",
    topics: ["conversion-cta", "forms"],
    claim:
      "Average documented online cart abandonment rate is 70.22% across 50 studies. Among reasons other than browsing: extra costs too high 40%, required account creation 18%, overly long or complicated checkout 17%, and inability to see total order cost upfront 12%.",
    source_type: "paper",
  },
  {
    id: "baymard-checkout-fields",
    title: "Checkout Optimization: 5 Ways to Minimize Form Fields in Checkout",
    publisher: "Baymard Institute",
    url: "https://baymard.com/blog/checkout-flow-average-form-fields",
    topics: ["forms", "conversion-cta"],
    claim:
      "The average checkout flow contained 11.3 form fields in 2024, while most sites need only 8 in total — roughly 29% more fields than necessary.",
    source_type: "paper",
  },

  // ---- Laws of UX ----
  {
    id: "lawsofux-hicks",
    title: "Hick's Law",
    publisher: "Laws of UX",
    url: "https://lawsofux.com/hicks-law/",
    topics: ["conversion-cta", "visual-hierarchy", "heuristics"],
    claim:
      "The time it takes to make a decision increases with the number and complexity of choices. (Hick & Hyman, 1952.)",
    source_type: "paper",
  },
  {
    id: "lawsofux-fitts",
    title: "Fitts's Law",
    publisher: "Laws of UX",
    url: "https://lawsofux.com/fittss-law/",
    topics: ["conversion-cta", "a11y", "visual-hierarchy"],
    claim:
      "The time to acquire a target is a function of the distance to and size of the target: smaller targets and greater distances raise error rates. Interactive elements should be large enough to select accurately and spaced to prevent accidental activation. (Paul Fitts, 1954.)",
    source_type: "paper",
  },
  {
    id: "lawsofux-jakobs",
    title: "Jakob's Law",
    publisher: "Laws of UX",
    url: "https://lawsofux.com/jakobs-law/",
    topics: ["heuristics", "conversion-cta"],
    claim:
      "Users spend most of their time on other sites, so they prefer your site to work the same way as all the other sites they already know.",
    source_type: "paper",
  },
  {
    id: "lawsofux-von-restorff",
    title: "Von Restorff Effect",
    publisher: "Laws of UX",
    url: "https://lawsofux.com/von-restorff-effect/",
    topics: ["visual-hierarchy", "conversion-cta"],
    claim:
      "When multiple similar objects are present, the one that differs from the rest is most likely to be remembered — with the caveat that emphasis must be used with restraint to avoid competing emphases. (Hedwig von Restorff, 1933.)",
    source_type: "paper",
  },
  {
    id: "lawsofux-millers",
    title: "Miller's Law",
    publisher: "Laws of UX",
    url: "https://lawsofux.com/millers-law/",
    topics: ["copy", "visual-hierarchy", "forms"],
    claim:
      "The average person can keep only 7 (plus or minus 2) items in working memory; organise content into smaller chunks to help people process and remember it.",
    source_type: "paper",
  },

  // ---- Growth.Design ----
  {
    id: "growthdesign-social-proof",
    title: "Social Proof: Why people's behaviors affect our actions",
    publisher: "Growth.Design",
    url: "https://growth.design/case-studies/social-proof",
    topics: ["conversion-cta", "copy"],
    claim:
      "People's behaviours affect our actions: observing what others do influences individual decision-making, which is why product interfaces surface reviews, counts and usage signals near a decision point.",
    source_type: "paper",
  },

  // ---- W3C / WCAG ----
  // Accessibility findings need normative criteria, and none of the four
  // publishers above provide them. Added deliberately, and flagged as an
  // addition to what Kelly named.
  {
    id: "wcag-name-role-value",
    title: "Understanding Success Criterion 4.1.2: Name, Role, Value (Level A)",
    publisher: "W3C Web Accessibility Initiative",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
    topics: ["a11y", "forms"],
    claim:
      "WCAG 2.2 Level A: \"For all user interface components (including but not limited to: form elements, links and components generated by scripts), the name and role can be programmatically determined.\" An interactive element with no accessible name fails this criterion.",
    source_type: "paper",
  },
  {
    id: "wcag-labels-or-instructions",
    title: "Understanding Success Criterion 3.3.2: Labels or Instructions (Level A)",
    publisher: "W3C Web Accessibility Initiative",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html",
    topics: ["a11y", "forms"],
    claim:
      'WCAG 2.2 Level A: "Labels or instructions are provided when content requires user input."',
    source_type: "paper",
  },

  // ==========================================================================
  // Added 2026-08-19, against measured gaps rather than guessed ones.
  //
  // The uncited rate had been read as 85% for days. Corrected, it is 61.6% —
  // 45 of the 73 findings Research actually saw. Those 45 were read one by one
  // and they cluster: ~16 on plain language, jargon and acronyms; ~9 on cost
  // and pricing transparency; ~4 on CTA label specificity; ~3 on WCAG criteria
  // we did not hold. Nothing below was chosen because it seemed like a good
  // source — each one answers a cluster that exists.
  //
  // Every URL was fetched on 2026-08-19 and every claim written from the page.
  // That is not ceremony: the first pricing URL tried here 404'd, exactly as a
  // guessed growth.design URL did when this table was first built.
  //
  // What is deliberately NOT here: anything for the ~8 findings whose heuristic
  // is a Nielsen heuristic named verbatim. `nng-ten-heuristics` already covers
  // those and is the most-cited row in the table. Whether those declines are
  // correct restraint against a general source or over-declining is a separate
  // question, and adding a source would answer it by hiding it.
  // ==========================================================================

  {
    id: "nng-plain-language",
    title: "Plain Language Is for Everyone, Even Experts",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/plain-language-experts/",
    topics: ["copy", "heuristics"],
    claim:
      "From usability studies with domain experts in science, technology and medical fields: \"even highly educated online readers crave succinct information that is easy to scan, just like everyone else.\" Guidance given — write at a 10th–12th grade reading level for experts and scholars, keep sentences to \"no more than 15–20 words\", and \"aim to use fewer than 50% of the words you would use in a printed publication\". (Hoa Loranger, 8 October 2017.)",
    source_type: "paper",
  },
  {
    id: "nng-user-centric-language",
    title: "Writing to Attract Readers: User-centric vs. Maker-centric Language",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/user-centric-language/",
    topics: ["copy", "conversion-cta"],
    claim:
      "\"Vague business terms, marketing language, and fluffy words are too hard for users to understand.\" The pull toward them is structural: \"It's much easier for writers to use the internal jargon and industry terms that are regularly used inside the company.\" The standard set is comprehension without effort — \"Users shouldn't have to interpret content; they should be able to easily understand it.\" (Janelle Estes, 28 September 2013.)",
    source_type: "paper",
  },
  {
    /**
     * The counterweight, and the reason this row matters more than its size.
     *
     * The two rows above can be read as "jargon is bad", which is not what the
     * research says and would licence a finding against every specialist site we
     * audit. This one says the opposite where the opposite is true, so a
     * reviewer citing a plain-language source at an expert audience can be
     * answered from the same corpus.
     */
    id: "nng-specialized-language",
    title: "Use Specialized Language for Specialized Audiences",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/specialized-words-specialized-audience/",
    topics: ["copy", "heuristics"],
    claim:
      "Jargon is not universally a defect: \"For professionals, enthusiasts, hobbyists, or others who specialize in a field, using that field's jargon improves communication\", and \"Specialized language is not only more concise but also clearer, as long as the reader is a specialist who understands the terminology.\" The condition is the audience — \"If you're writing for beginners or trainees, it's certainly best to define any specialized terms you're using.\" (Jakob Nielsen, 16 November 2014.)",
    source_type: "paper",
  },
  {
    id: "nng-better-link-labels",
    title: "Better Link Labels: 4Ss for Encouraging Clicks",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/better-link-labels/",
    topics: ["conversion-cta", "copy"],
    claim:
      "Four qualities of a working link or button label: \"Write specific links that set sincere expectations and fulfill them, that are substantial enough to stand alone while remaining as succinct as possible.\" A label's job is to say \"what they'll find on the other side of a click\"; \"A link is a promise\"; and it \"must be able to stand alone\" if the reader sees only the label and none of the surrounding text. (Kate Moran, 24 March 2019.)",
    source_type: "paper",
  },
  {
    /**
     * The nine cost-transparency findings were not uncited because the corpus
     * lacked anything on cost — `baymard-cart-abandonment` covers extra costs
     * in detail. They were uncited because that row's claim is about *checkout*,
     * and the findings were on pricing pages. Research declined to stretch it,
     * which was the right call. This row is what it should have been able to
     * reach for instead.
     */
    id: "nng-show-price",
    title: "State the Price to Give B2B Sites a Competitive Advantage",
    publisher: "Nielsen Norman Group",
    url: "https://www.nngroup.com/articles/show-price/",
    topics: ["conversion-cta", "copy"],
    claim:
      "\"Business customers report pricing as the top most needed piece of information online.\" Withholding it is not neutral: \"Not showing pricing works against customer needs and thus creates a hostile shopping experience\", and \"People view companies that hide costs as being evasive and untrustworthy.\" Where exact pricing is genuinely not possible, the recommendation is sample prices for representative scenarios rather than a configurator. (Hoa Loranger, 1 December 2013.)",
    source_type: "paper",
  },
  {
    id: "wcag-info-and-relationships",
    title: "Understanding Success Criterion 1.3.1: Info and Relationships (Level A)",
    publisher: "W3C Web Accessibility Initiative",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html",
    topics: ["a11y", "visual-hierarchy"],
    claim:
      "WCAG 2.2 Level A: \"Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.\" The criterion does not name headings normatively; its Intent section gives them as an example of structure a sighted reader perceives visually — \"headings are often in a larger, bold font separated from paragraphs by blank lines\" — which must also be programmatically determinable.",
    source_type: "paper",
  },
  {
    id: "wcag-target-size-minimum",
    title: "Understanding Success Criterion 2.5.8: Target Size (Minimum) (Level AA)",
    publisher: "W3C Web Accessibility Initiative",
    url: "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html",
    topics: ["a11y", "conversion-cta"],
    claim:
      "WCAG 2.2 Level AA: \"The size of the target for pointer inputs is at least 24 by 24 CSS pixels\", subject to five enumerated exceptions (Spacing, Equivalent, Inline, User Agent Control, Essential).",
    source_type: "paper",
  },
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/** The only way a source is looked up. Unknown ids return null, never a guess. */
export function sourceById(id: string): Source | null {
  return BY_ID.get(id) ?? null;
}

/** The shortlist a reviewer's findings may cite. Empty topics means everything. */
export function sourcesFor(topics: string[]): Source[] {
  if (topics.length === 0) return SOURCES;
  const wanted = new Set(topics);
  return SOURCES.filter((s) => s.topics.some((t) => wanted.has(t)));
}

/**
 * Turns whatever the Research agent said into a citation.
 *
 * The single choke point, and the reason no URL the model produces can ever
 * reach a page: this function takes an id and reads the url from the table.
 * There is no argument through which a URL could be passed in.
 *
 * Anything unrecognised becomes `none`, which §9.3 makes a legal, unpunished
 * output — displayed as "based on our evaluation" rather than a fabricated
 * authority.
 */
export function resolveCitation(sourceId: string | null | undefined): Citation {
  const source = sourceId ? sourceById(sourceId) : null;
  if (!source) return { source_type: "none", url: null };
  return { source_type: source.source_type, url: source.url };
}
