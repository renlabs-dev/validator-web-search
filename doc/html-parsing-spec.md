# HTML Parsing on the Open Web — Generalized Approach (Spec)

This document describes the problem space of turning arbitrary web pages into reliable text suitable for downstream embeddings/rerank and LLM judging. It focuses on generalized, idiomatic approaches and enumerates edge cases and failure modes. It does not prescribe a single “best” solution.

## Scope

- Input: URLs from a web search (heterogeneous domains; news, finance, blogs, portals).
- Output: Cleaned textual content emphasizing factual evidence (numbers, dates, quotes) for verification tasks.
- Constraints: Cost/time sensitive; robust to malformed HTML and anti‑bot measures; minimal per‑site logic.

## Pipeline Context (current system)

- Fetch with an unblocking layer (ScraperAPI). Detect bot walls/blocked content.
- Convert HTML → text via a robust library with content‑targeting and boilerplate skipping.
- Chunk, embed, rerank by a focused query; pass ranked snippets to a strict judge; short‑circuit on evidence.
- Budgeted sequential processing; snippet fallback on fetch failure.

Key components: `src/test/scraper.pipeline.ts`, `src/scraper/scraper.fetch.ts`, `src/scraper/scraper.text.ts`, `src/llm/embeddings.ts`, `src/scraper/scraper.summarize.ts`.

## Edge Cases and Challenges

1) Boilerplate & Navigation Noise
- Top/side nav, footers, cookie banners, newsletter modals, related links, tag clouds.
- Link hrefs injected into text (e.g., `[https://…]`) overshadowing content.
- Pagination controls, infinite scroll prompts.

2) Dynamic/Rendered Content
- JS‑rendered tables and lazy‑loaded sections (HTML fetch returns skeleton without data).
- Client‑side hydration; content only in a rendered DOM.

3) Tables & Grids
- Financial/price history tables with merged cells, sticky headers, footers.
- Layout tables vs data tables; embedded charts with ARIA labels; hidden columns.
- Text extraction may collapse columns, making rows hard to identify.

4) Numbers & Dates (Localization)
- Decimal/thousand separators vary (`,`, `.`, thin‑space, apostrophes).
- Non‑Latin numerals (e.g., Arabic‑Indic digits), mixed scripts.
- Month name localization; abbreviated vs full names.

5) Time & Timezones
- Stamps shown in local time; ambiguous relative terms (“yesterday”, “today”).
- Mixed time zones and markets (UTC vs exchange local).

6) Encoding & Unicode
- Non‑breaking spaces, soft hyphens, directional marks (RTL LRM/RLM), zero‑width chars.
- Copy‑pasted quotes/symbols that differ from ASCII equivalents.

7) Links & URLs
- Inline link text repeated with URLs, creating long noise sequences.
- Anchor fragments and tracking parameters.

8) Invalid/Messy Markup
- Unclosed tags, duplicate IDs, malformed attributes, illegal nesting.
- Content outside expected containers (no `<main>`/`<article>`/roles present).

9) Consent/Paywalls/Interstitials
- GDPR/CCPA overlays; “Sign in to read”; paywalled content with partial previews.
- “Something went wrong” placeholders cached by CDNs.

10) Anti‑bot/Rate Limits
- Cloudflare/Datadome/PerimeterX challenges with misleading HTTP 200 bodies.
- IP‑based throttling; geo/locale gates.

11) Pagination/Infinite Scroll
- Only first page crawled; evidence on later pages.
- “Load more” buttons; virtualized lists.

12) Frames/Embeds/Shadow DOM
- Content inside iframes; embedded widgets; shadow DOM content not in raw HTML.

13) Structured Data vs Visible Text
- JSON‑LD or microdata has facts not visible; or visible differs from metadata.

14) Media‑Encoded Text
- Text in images/SVG/canvas; charts carrying numeric labels not present as DOM text.

15) Canonicalization & Variants
- Mobile vs desktop markup; AMP vs canonical; print views.
- Content negotiation by User‑Agent/Accept‑Language.

16) Duplicates & Boilerplate within Content
- Repeated headers per section; TOCs injected into text; inline ads.

## Generalized, Idiomatic Approaches (Survey)

- Library‑based HTML→Text
  - Use a mature converter (e.g., `html-to-text`) to robustly handle malformed HTML.
  - Configure to target likely content containers (`main`, `article`, roles), and skip nav/header/footer/aside/forms/buttons/etc.
  - Suppress link href text to reduce URL noise; normalize whitespace.
  - Pros: robust, fast, minimal per‑site logic. Cons: still heuristic; table structure not preserved.

- Readability‑style Main‑Content Extraction
  - Apply algorithms (e.g., Mozilla Readability) on a DOM to find the primary article/content block.
  - Pros: better boilerplate removal. Cons: needs a DOM; may miss non‑article pages (e.g., data tools/tables).

- Rendered DOM (Headless/Prerender)
  - Use ScraperAPI “JavaScript rendering” for JS‑dependent content.
  - Pros: captures client‑rendered tables and lazy content. Cons: cost/latency; still need extraction logic.

- ScraperAPI `output_format=text`
  - Server‑side HTML→text flattening.
  - Pros: smaller payloads. Cons: includes nav/link noise; little tuning control; same issues seen with nav‑heavy outputs.

- Heuristic Content Targeting
  - Keyword windows for domain‑agnostic patterns (e.g., “Historical Prices”, “Date Open High Low Close”).
  - Pros: cheap, broad. Cons: brittle on language/format variations; must avoid site‑specific hacks.

- Table Extraction Strategies
  - Plain text (embedding‑friendly) vs visually faithful (`dataTable`) vs parsing HTML tables to TSV.
  - Pros/cons tradeoff between structural fidelity and embedding usefulness.

- Chunking Strategies
  - Fixed‑size chars; sentence/paragraph aware; overlap for context retention.
  - Pros: controls cost vs recall; cons: wrong boundaries can split evidence.

- Post‑Validation
  - Verbatim quote checks against provided text; JSON schema enforcement for judge output.
  - Pros: mitigates hallucination; Cons: requires careful text fidelity.

## What We Cover Well (Generalized)

- Robust HTML→text via a library with:
  - Content targeting (`main`/`article`/roles) and broad boilerplate skipping (nav/header/footer/aside/forms/buttons/svg/scripts/styles/noscript).
  - Link href suppression and whitespace normalization to reduce noise.
- Sequential source processing with early stop reduces embedding/judge cost and context bloat.
- Strict judge with Zod parsing and quote verification protects against unsupported claims.
- Budgeted fetch with fallback to SERP snippet keeps runs productive under blocking.
- Blocked‑page heuristics to avoid feeding interstitials to embeddings.

## Likely Failure Modes (Generalized)

- JS‑heavy sites where critical content is injected client‑side (requires JS rendering to see data).
- Sites without clear content containers; boilerplate still leaks into text and can crowd top chunks.
- Large/complex tables where plain text collapses columns; exact row/column matching becomes hard.
- Locale‑specific numbers/dates (thin spaces, commas as decimal) causing pattern mismatches or mis‑ranking.
- Evidence behind paywalls/consent; partial previews omit needed rows/dates.
- Content in iframes/embeds/shadow DOM not present in fetched HTML.
- Images/charts with numeric labels; no textual equivalent to quote.
- Anti‑bot pages that evade heuristics and look like content.
- Infinite scroll/pagination hides relevant rows beyond the first page.

## ScraperAPI Settings — Considerations

- JavaScript Rendering
  - Use when HTML lacks expected signals or content appears skeletal; renders client‑side tables and lazy content.
  - Tradeoffs: higher cost/latency; potential for anti‑bot triggers; still need post‑processing and blocking checks.

- `output_format=text`
  - Not recommended by default; tends to include navigation/link noise and reduces control. Treat as a narrow fallback.

- Other knobs
  - `retry_404`, `sa-from-cache`, `sa-credit-cost`, `max_cost` budgeting are useful for reliability and cost control.

## Observability

- Log chunk previews and scores to detect noise dominating early chunks.
- Track scrape credit spend to correlate cost vs evidence yield.
- Optional debug dumps of a limited prefix of text to diagnose extraction issues without flooding logs.

## Maintenance & Evolution

- Refresh anti‑bot/blocked‑page signatures periodically.
- Keep content‑targeting selectors broad and domain‑agnostic; avoid site‑specific hacks.
- Consider a tiny declarative nudge list (keywords/selectors) for high‑value domains if strictly necessary.
- Prepare for locale expansion: normalize digits and separators where feasible.

## Decision Landscape (Non‑Prescriptive)

- Raw HTML + library text extraction: strong general baseline; keep tuned selectors and normalization.
- Add Readability‑style extraction for article‑like pages; fall back to baseline for data tools.
- Enable JS rendering selectively for pages missing signals; avoid global use due to cost.
- Keep `output_format=text` as a fallback only; always post‑filter text before chunking.
- Prefer simple, domain‑agnostic heuristics over per‑site code to stay maintainable and future‑proof.

