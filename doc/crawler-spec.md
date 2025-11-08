# SERP → Crawl → Embeddings: Minimal Escalation Spec (Pseudocode)

> using https://www.firecrawl.dev/

---

## Constants, weights, and budgets

```pseudocode
CONST MAX_QUERIES        = 10         # total SERP attempts per claim
CONST TOP_K_RESULTS      = 8          # inspect top-N SERP items each attempt
CONST CRAWLS_PER_TURN    = 2          # at most 2 crawls per SERP turn (official + corroboration)
CONST TOTAL_CRAWLS       = 4          # safety cap across the whole claim
CONST MAX_HOPS_FROM_PAGE = 1          # optional single clickdown from hubs <- get rid of this
CONST EMBED_CHUNKS_MAX   = 12         # make up to 12 chunks per page for rerank <- probably can get rid of this
CONST EMBED_TAKE         = 3          # actually read top 3 chunks only <- probably can get rid of this
CONST DATE_TOLERANCE_H   = 48         # allow ±48h between agreeing sources <- remove
CONST AGREEMENT_SCORE    = 1.6        # sufficiency threshold for source weights

# Authority weights for sufficiency scoring
WEIGHT = {
  "official": 1.0,   # .gov, regulator, organizer, company pressroom
  "wire":     0.8,   # AP/Reuters/major wire
  "trade":    0.6,   # credible specialized press
  "other":    0.4    # blogs/aggregators — use as leads only
}
```

---

## Core data models

```pseudocode
type Claim = {
  id: int
  text: string
  class: enum("StateChange","Availability","Threshold","CompetitiveOutcome","EventRelative") <- get rid of this
  timeframe: { start_utc: datetime|null, end_utc: datetime|null }  # already extracted
}

type SerpItem = { title: string, snippet: string, url: string, domain: string }

type Evidence = {
  url: string
  domain: string
  domain_type: enum("official","wire","trade","other")
  event_datetime_utc: datetime           # the occurrence date/time you will compare to timeframe
  extraction: enum("snippet","structured","embedding","tablepdf","clickdown") <- useless
  note: string                           # small “where found” (e.g., JSON-LD datePublished, "Decision date: ...")
}

type Decision = {
  status: enum("decide","crawl","refine") <- further investigatr the decide, when is it used ?
  picks: list<url>                       # when status="crawl", shortlist to fetch (prioritize official + wire)
}
```

---

## Top-level orchestration

```pseudocode
function verify_claim_with_serper(claim: Claim, now_utc: datetime) -> Outcome:
    # Maturity gate is assumed handled earlier; this function only resolves via web evidence.
    evidence_list = []
    crawls_used = 0
    query = compose_initial_query(claim)     # deterministic template per claim.class
    attempt = 1

    while attempt <= MAX_QUERIES:
        serp = serper.search(query, top=TOP_K_RESULTS)

        # Ask tiny model to decide from snippets alone, or tell us which 2 URLs to crawl.
        gate = snippet_gate(serp, claim)

        if gate.status == "decide":
            # The model asserts 2 agreeing, dated, independent sources are in snippets.
            ev_from_snippets = extract_evidence_from_snippets(serp, claim)  # regex on snippet + date parsing
            evidence_list += ev_from_snippets
            if evidence_sufficient(evidence_list, claim.timeframe):
                return decide_outcome_from_evidence(evidence_list, claim)
            # If model overconfident and we still can't confirm, drop to crawl branch below.

        if gate.status == "crawl" and crawls_used < TOTAL_CRAWLS:
            # Crawl up to 2 pages this turn: best official + best independent corroboration.
            urls = select_two_for_crawl(gate.picks)  # enforce independence and variety
            for url in urls:
                if crawls_used >= TOTAL_CRAWLS: break
                page_ev = crawl_and_extract(url, claim)  # cheap pass, then embeddings if needed
                crawls_used += 1
                evidence_list += page_ev
                if evidence_sufficient(evidence_list, claim.timeframe):
                    return decide_outcome_from_evidence(evidence_list, claim)

        # If we reach here, we either didn't have enough evidence or hit per-turn crawl cap; refine query.
        query = refine_query(query, evidence_list, claim)
        attempt += 1

    # Out of attempts; degrade gracefully.
    return decide_with_missing_or_mostly(evidence_list, claim)
```

---

## SERP → action triage (`snippet_gate`)

```pseudocode
function snippet_gate(serp: list<SerpItem>, claim: Claim) -> Decision:
    # Heuristics + tiny model:
    # - If serp contains ≥2 items that look authoritative AND each snippet shows an explicit date AND
    #   their dates agree within ±DATE_TOLERANCE_H → status="decide".
    # - Else status="crawl" with best official + best independent candidate URLs.
    # - If no authoritative domains in top-8 → status="refine".

    candidates = score_serp_items(serp, claim)  # authority + cues + within window
    top_auth = filter_authoritative(candidates) # official/wire/trade only

    if count(top_auth.with_explicit_dates) >= 2 and agree(top_auth.with_explicit_dates, DATE_TOLERANCE_H):
        return Decision("decide", [])

    if not empty(top_auth):
        picks = shortlist_for_crawl(top_auth)  # prefer 1 official + 1 wire/trade, hub cues get a boost
        return Decision("crawl", picks)

    return Decision("refine", [])
```

**SERP scoring cues (keep it tiny):**

```pseudocode
function score_serp_items(serp, claim):
    # base = WEIGHT[domain_type(url)]
    # +0.3 if title/url contains any of: "press release","official results","order","decision","box score","pdf"
    # +0.2 if snippet shows a 4-digit year or month-name date
    # +0.2 if page date (if provided) falls within claim.timeframe window
    # return list sorted by descending score
```

---

## Crawl → extract (cheap first, then embeddings if needed)

```pseudocode
function crawl_and_extract(url: string, claim: Claim) -> list<Evidence>:
    page = firecrawler.fetch(url)  # HTML + links + mime type
    ev = []

    # 1) Cheap structured pass (no embeddings)
    maybe = cheap_extract_event_datetime(page, claim)
    if maybe.found_single_confident:
        ev.append(evidence(url, page, maybe.datetime_utc, "structured", maybe.note))
        return ev

    # 2) If the page looks like a hub, allow one clickdown to 1–2 high-signal links (press/results/order/pdf).
    if looks_like_hub(page) and MAX_HOPS_FROM_PAGE > 0:
        links = score_clickdown_links(page)  # same cue set as SERP scoring but stricter, same-domain boost
        for link in take(links, 2):
            sub = firecrawler.fetch(link)
            sub_ev = cheap_extract_event_datetime(sub, claim)
            if sub_ev.found_single_confident:
                ev.append(evidence(link, sub, sub_ev.datetime_utc, "clickdown", sub_ev.note))
                return ev  # early-stop from clickdown
        # fall through to embeddings if clickdown didn’t resolve

    # 3) Embedding rerank (only now, only if necessary)
    chunks = chunk(page.text, size=1000, overlap=200, with_heading_paths=true)
    focus = focus_string_for_claim(claim)  # verbs + entities for this class
    top_chunks = embedding_rerank(chunks, query=focus, take=EMBED_TAKE)  # cosine + tiny lexical boost
    emb_ev = extract_event_datetime_from_chunks(top_chunks, claim)

    if emb_ev.found_single_confident:
        ev.append(evidence(url, page, emb_ev.datetime_utc, "embedding", emb_ev.note))
        return ev

    # 4) If still ambiguous, return whatever weak hints we found (won’t satisfy sufficiency but helps refine).
    return ev
```

---

## Cheap extractor (deterministic)

```pseudocode
function cheap_extract_event_datetime(page, claim):
    # Priority: JSON-LD (datePublished/dateModified) → <time datetime> → article meta → regex in title/H1/H2/lead paragraphs
    # IMPORTANT: prefer EVENT/RESULT/DECISION phrases over publish/update dates when both exist.
    # Return {found_single_confident: bool, datetime_utc: datetime, note: string}

    # A) JSON-LD
    dt = jsonld_find(page, keys=["datePublished","dateCreated","dateModified"])
    if dt and matches_event_language(page, claim):  # “approved”, “wins”, “launched”, “official results”, “decision”
        return {true, to_utc(dt, infer_tz(page)), "jsonld:datePublished"}

    # B) <time datetime>
    dt = html_time_tags(page)
    if dt and near_event_phrases(page, dt, claim):
        return {true, to_utc(dt, infer_tz(page)), "<time datetime>"}

    # C) Meta/OG
    dt = meta_dates(page)
    if dt and matches_event_language(page, claim):
        return {true, to_utc(dt, infer_tz(page)), "meta:article:published_time"}

    # D) Regex in salient sections
    dt = regex_scan(preferred_sections(page, claim))  # H1/H2 + ±2 paragraphs, table headers/cells
    if dt:
        return {true, to_utc(dt, infer_tz(page)), "regex:salient"}

    return {false, null, ""}
```

---

## Embedding rerank extractor (only if cheap failed)

```pseudocode
function focus_string_for_claim(claim: Claim) -> string:
    switch claim.class:
        case "StateChange":        return "{subject} approved|denied|ordered|enacted {object}"
        case "Availability":       return "{object} release|launch|available|GA"
        case "Threshold":          return "{metric} close|>=|<=|cross|first time {value}"
        case "CompetitiveOutcome": return "{team/entity} wins|defeats|final|official results|box score"
        case "EventRelative":      return "{subject} release|launch after|before {trigger}"

function extract_event_datetime_from_chunks(chunks, claim):
    # Scan top-3 chunks for explicit dates that co-occur with class verbs.
    for c in chunks:
        dt = regex_date(c.text)
        if dt and matches_event_language(c.text, claim):
            return {true, to_utc(dt, infer_tz_from_text_or_page(c)), "embedding:chunk"}
    return {false, null, ""}
```

---

## Sufficiency and outcome

```pseudocode
function evidence_sufficient(evs: list<Evidence>, timeframe) -> bool:
    # 1) Keep only items whose event_datetime_utc falls within timeframe (if timeframe present).
    in_window = filter(lambda e: within(e.event_datetime_utc, timeframe), evs)

    # 2) Find 2 independent domains whose dates agree within tolerance.
    pairs = all_pairs(in_window)
    for (a,b) in pairs:
        if a.domain != b.domain and
           abs_hours(a.event_datetime_utc - b.event_datetime_utc) <= DATE_TOLERANCE_H and
           WEIGHT[a.domain_type] + WEIGHT[b.domain_type] >= AGREEMENT_SCORE:
            return true
    return false

function decide_outcome_from_evidence(evs, claim) -> Outcome:
    # You already know we have 2 agreeing, dated sources in-window.
    # Map to outcomes by claim.class semantics (examples; keep simple):
    # - StateChange/Availability/CompetitiveOutcome: event date occurred within window → MaturedTrue else MaturedFalse.
    # - Threshold: confirm first crossing within window → MaturedTrue; if never crossed → MaturedFalse.
    return build_outcome(evs, claim, label="MaturedTrue/MaturedFalse/Mostly* as needed")

function decide_with_missing_or_mostly(evs, claim) -> Outcome:
    # If we collected partial or conflicting evidence (e.g., digital true, physical later),
    # return MostlyTrue/MostlyFalse with a short note; else MissingContext.
    return build_outcome_fallback(evs, claim)
```

---

## URL selection and helpers

```pseudocode
function select_two_for_crawl(picks: list<url>) -> list<url>:
    # Enforce: 1 official if available, + 1 independent (wire or credible trade).
    official = first(filter(is_official, picks))
    indie    = first(filter(lambda u: not same_domain(u, official) and (is_wire(u) or is_trade(u)), picks))
    out = []
    if official: out.append(official)
    if indie:    out.append(indie)
    if empty(out):
        out = take(picks, 2)  # fallback: top-2 diverse by domain
    return out

function looks_like_hub(page) -> bool:
    # Signals: many outbound links; title or anchors contain {press, results, order, decision, box score, pdf}
    return hub_signals(page) >= 2

function score_clickdown_links(page) -> list<url>:
    # Rank same-domain (or whitelisted) links that look like canonical artifacts.
    links = extract_links(page)
    return sort_by(links, key = (
        is_same_domain_boost +
        anchor_contains({"press release","official results","order","decision","box score"}) +
        url_path_contains({"/press/","/news/","/results/","/orders/","/filings/","/events/"}) +
        is_pdf_and_official_boost
    ))
```

---

## Query composition and refinement (tiny, deterministic)

```pseudocode
function compose_initial_query(claim: Claim) -> string:
    switch claim.class:
        case "StateChange":        return "<subject> <transition verb> <object> (site:official OR site:wire)"
        case "Availability":       return "<entity/object> release|launch date (site:official OR site:label/vendor OR site:trade)"
        case "Threshold":          return "<metric/series> <window hint> site:<canonical datasource>"
        case "CompetitiveOutcome": return "<contest name> official results (site:<governing body> OR site:apnews.com OR site:reuters.com)"
        case "EventRelative":      return "<trigger event> <city/venue> dates (site:<organizer> OR site:<venue>)"

function refine_query(query, evs, claim) -> string:
    # Add one tweak per attempt; keep deterministic:
    # - inject year/month from timeframe
    # - add venue/city/object name if we saw it in snippets
    # - tighten site: set (official→wire→trade) or flip tbm=nws when needed
    return small_tweak(query, evs, claim)
```

---

## Tiny prompt sketches (for your small model)

**`snippet_gate` (SERP → action)**

```text
Task: From top SERP items, decide the next action for this claim.

Claim: "<text>"
Timeframe UTC: start=<start|null>, end=<end|null>
Class: <StateChange|Availability|Threshold|CompetitiveOutcome|EventRelative>

For each item, you have: {title, snippet, url, domain}.

Rules:
- If there are 2 independent items (different domains) that each include an explicit event/result date,
  and the two dates agree within ±48 hours, and both look authoritative (official/wire/trade),
  return: {"status":"decide"}.
- Otherwise, return {"status":"crawl","picks":[up to 3 urls]} choosing one official if present,
  and one independent (wire/trade). Prefer items whose titles/URLs look like press releases, official results, orders, filings, PDFs.
- If none of the top items are authoritative, return {"status":"refine"}.

Output JSON only.
```

**Focus string for embeddings** — already covered by `focus_string_for_claim`.

---

## Minimal instrumentation (recommended)

```pseudocode
log({
  claim_id: claim.id,
  queries_used: attempt,
  crawls_used: crawls_used,
  evidence_count: len(evidence_list),
  classes: claim.class,
  tiers: tier_summary_from(evidence_list),        # snippet / structured / embedding / clickdown
  domains: unique_domains(evidence_list),
  latency_ms: stopwatch()
})
```
