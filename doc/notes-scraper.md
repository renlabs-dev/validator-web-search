# ScraperAPI — Minimal Escalation Playbook (for your **SERP → Crawl → Embeddings** pipeline)

This doc is your drop-in guide to replace `firecrawler.fetch` with **ScraperAPI** as a _fetcher + unblocking_ layer, while you keep doing link discovery and downstream parsing yourself.

---

## What ScraperAPI gives you (in this pipeline)

- A single endpoint that **fetches pages** and handles **proxies / JS rendering / anti-bot** for you. ([docs.scraperapi.com][1])
- **Per-request feature toggles** (JS rendering, premium/ultra-premium IP pools, etc.) so you only pay “heavy” credits on the URLs that truly need it. ([docs.scraperapi.com][2])
- **Success-only billing** (charged on `200` and `404`), plus a cost header so you can log exactly what each URL cost. ([docs.scraperapi.com][3])
- **Pre-flight cost check** and **per-request max cost** to prevent surprise spend. ([docs.scraperapi.com][3])

---

## Endpoints you’ll use

- **Sync:** `https://api.scraperapi.com?api_key=...&url=...` (2 MB response limit). Recommended client timeout: **≈70s**. ([docs.scraperapi.com][1])
- **Async:** `https://async.scraperapi.com/...` (job/status flow). Use when success rate matters more than latency. ([docs.scraperapi.com][4])

---

## Parameters you’ll care about (and their credit costs)

| Param                     | What it does                                                              | Credits                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `render=true`             | Headless Chrome render for JS-heavy pages.                                | **10** (or **75** when combined with `ultra_premium=true`). ([docs.scraperapi.com][2])                              |
| `premium=true`            | Residential/mobile proxy pool.                                            | **10** (or **25** with `render=true`). ([docs.scraperapi.com][2])                                                   |
| `ultra_premium=true`      | Heaviest proxy pool for very hard targets (e.g., LinkedIn).               | **30** (or **75** with render). Note: **custom headers not allowed** with ultra-premium. ([docs.scraperapi.com][5]) |
| _(Protected-site bypass)_ | Cloudflare / DataDome / PerimeterX bypass, **when required by the site**. | **+10** on top of base cost. (Auto-applied; check pre-flight.) ([docs.scraperapi.com][3])                           |
| `session_number=...`      | Sticky IP session; expires **≈15 minutes** after last use.                | **0** credits; **not combinable with premium/ultra_premium**. ([docs.scraperapi.com][6])                            |
| `keep_headers=true`       | Use your own headers (UA, cookies).                                       | **0** credits; **don’t** use unless required; **not compatible with ultra_premium**. ([docs.scraperapi.com][7])     |
| `country_code=us`         | Geotargeting.                                                             | **0** credits. ([docs.scraperapi.com][2])                                                                           |
| `wait_for_selector=...`   | Wait for element while rendering.                                         | **0** credits. ([docs.scraperapi.com][3])                                                                           |
| `screenshot=true`         | Full-page PNG; implies render.                                            | **+10** credits; URL returned in `sa-screenshot` header. ([docs.scraperapi.com][8])                                 |

**Domain category base costs** (applied before params): **Normal=1**, **Amazon=5**, **Google/Bing SERP=25**, **LinkedIn=30**. Use the pre-flight endpoint to see the exact credit total for a given URL + params. ([docs.scraperapi.com][3])

---

## Cost math (keep it simple)

- **$/1k pages = (plan $ / plan credits) × 1000 × (credits per request)**
  Example (Startup plan **$149 / 1,000,000 credits**):
  - Plain (1 credit) → **$0.149 / 1k**
  - Render **(10)** → **$1.49 / 1k**
  - Premium **(10)** → **$1.49 / 1k**
  - Render+Premium **(25)** → **$3.725 / 1k**
  - Render+Premium + Cloudflare **(35)** → **$5.215 / 1k**
  - Ultra-premium **(30)** → **$4.47 / 1k**
  - Ultra-premium+Render **(75)** → **$11.175 / 1k**
    _(Plan pricing & credit counts from ScraperAPI’s pricing page.)_ ([ScraperAPI][9])

> ScraperAPI **bills on success** (`200`/`404`) and **also** if _you_ cancel before their ~**70s** internal retry window completes. Set your client timeout **≥70s** to avoid accidental charges. ([docs.scraperapi.com][3])

---

## Pre-flight & spend caps (use these on every call)

- **Pre-flight cost:**
  `GET https://api.scraperapi.com/account/urlcost?api_key=...&url=<target>&render=true&premium=true`
  → returns the **exact credits** the request would cost **for that URL** and param set. Use it to auto-decide the cheapest viable mode. ([docs.scraperapi.com][3])

- **Per-request hard cap:**
  Add `max_cost=<credits>` to **fail fast** if the URL would exceed your budget; you’ll get a 403 if the estimate is higher. ([docs.scraperapi.com][10])

---

## Minimal escalation ladder (drop-in for your pseudocode)

1. **Plain** (no params).
   If the HTML looks empty/skeletal or clearly client-rendered, retry with **`render=true`**. ([docs.scraperapi.com][11])

2. **If blocked** (403/503/“Attention Required”):
   escalate to **`premium=true`** (res/mobile pool). If still blocked and content is JS-heavy, combine **`premium + render`**. ([docs.scraperapi.com][2])

3. **If you know/expect WAFs (Cloudflare/DataDome/PerimeterX):**
   rely on **pre-flight**; if it returns an extra **+10** for bypass, proceed (or skip/route elsewhere). ([docs.scraperapi.com][3])

4. **Last resort:** **`ultra_premium=true`** (optionally with `render=true`). Remember: no custom headers with ultra-premium. ([docs.scraperapi.com][5])

**Tip:** log the response header **`sa-credit-cost`** to track real spend per URL; cached responses are tagged **`sa-from-cache: 1`**; screenshots come back in **`sa-screenshot`**. ([docs.scraperapi.com][3])

---

## Plug-in code sketch

```python
# fetch_with_escalation(url) — sync variant
# - Preflights cost, then escalates: plain -> render -> premium -> premium+render -> ultra
# - Enforces per-request max_cost
import requests

API = "https://api.scraperapi.com"
KEY = "<YOUR_API_KEY>"

def url_cost(url, **params):
    q = {"api_key": KEY, "url": url} | params
    r = requests.get(f"{API}/account/urlcost", params=q, timeout=20)
    r.raise_for_status()
    return int(r.json().get("cost", 0))

def get(url, **params):
    q = {"api_key": KEY, "url": url} | params
    r = requests.get(API, params=q, timeout=75)
    return r

def fetch_with_escalation(url, max_cost=35):
    modes = [
        {},  # plain
        {"render": "true"},
        {"premium": "true"},
        {"render": "true", "premium": "true"},
        {"ultra_premium": "true"},                     # last resort
        {"ultra_premium": "true", "render": "true"},   # nuclear
    ]
    for p in modes:
        est = url_cost(url, **p)
        if est <= max_cost:
            r = get(url, max_cost=str(max_cost), **p)
            if r.status_code in (200, 404):
                return r
    raise RuntimeError("No affordable mode found")
```

_(You can swap the mode order based on your telemetry; e.g., put `premium` before `render` if blocks are more common than SPAs.)_

---

## Integration points for your **SERP → triage → crawl** logic

- **Replace** `firecrawler.fetch(url)` with `fetch_with_escalation(url)`.
- **Keep** your snippet-gate and “2 sources agree” logic as-is.
- **Optional:** when `snippet_gate` predicts a **hard** domain (e.g., pressrooms behind Cloudflare), pre-flight with `render=true` to avoid a wasted plain attempt.

---

## Concurrency & timeouts

- Plan concurrency caps: **Hobby 20**, **Startup 50**, **Business 100**, **Scaling 200** concurrent threads. Keep your worker pool ≤ plan limit. ([ScraperAPI][9])
- **Set client timeout ≈70s** (sync) so ScraperAPI can finish its own retries without you aborting early (which still bills). ([docs.scraperapi.com][1])

---

## Gotchas & best practices

- **Don’t overuse custom headers.** ScraperAPI’s header system usually wins; set `keep_headers=true` only when needed. Not allowed with **ultra_premium**. ([docs.scraperapi.com][7])
- **Sessions:** only for flows that require stickiness; expire after ~**15 minutes**; not combinable with premium/ultra-premium. ([docs.scraperapi.com][6])
- **SERP pages:** scraping Google/Bing directly costs **25** base credits; since you already have a SERP provider, keep using it. ([docs.scraperapi.com][3])
- **Payload size:** each sync response is capped around **2 MB** — use **Async** for heavier pages. ([docs.scraperapi.com][1])
- **Screenshots:** `screenshot=true` is handy for debugging what the browser saw (URL in `sa-screenshot`). ([docs.scraperapi.com][12])

---

## Quick pricing reference (Monthly)

- **Hobby:** $49 / **100k credits** (20 threads)
- **Startup:** $149 / **1M credits** (50 threads)
- **Business:** $299 / **3M credits** (100 threads)
- **Scaling:** $475 / **5M credits** (200 threads)
  _(Yearly discounts apply.)_ ([ScraperAPI][9])

---

## Compliance note

Use this only where you’re allowed to automate. Respect site ToS/robots where applicable; prefer official APIs when available. ScraperAPI’s anti-bot handling runs on their side — you’re not implementing circumvention yourself. ([ScraperAPI][13])

---

## Copy-paste cURL examples

- **Plain:**
  `curl "https://api.scraperapi.com/?api_key=KEY&url=https://example.com"`

- **Render:**
  `curl "https://api.scraperapi.com/?api_key=KEY&url=https://example.com&render=true"` ([docs.scraperapi.com][11])

- **Premium + Render (hard targets):**
  `curl "https://api.scraperapi.com/?api_key=KEY&url=https://example.com&premium=true&render=true"` ([docs.scraperapi.com][2])

- **Ultra-premium (last resort):**
  `curl "https://api.scraperapi.com/?api_key=KEY&url=https://example.com&ultra_premium=true"` ([docs.scraperapi.com][5])

- **Pre-flight cost (recommended):**
  `curl "https://api.scraperapi.com/account/urlcost?api_key=KEY&url=https://example.com&render=true&premium=true"` ([docs.scraperapi.com][3])

---

### What to log per URL

- HTTP status, **`sa-credit-cost`**, `sa-from-cache` (if present), and the params you used. On success, store raw HTML + your normalized text for embeddings. ([docs.scraperapi.com][3])

---

[1]: https://docs.scraperapi.com/ "Making Requests | ScraperAPI Documentation"
[2]: https://docs.scraperapi.com/making-requests/customizing-requests "Customizing Requests | ScraperAPI Documentation"
[3]: https://docs.scraperapi.com/credits-and-requests "Credits and Requests | ScraperAPI Documentation"
[4]: https://docs.scraperapi.com/making-requests/async-requests-method "Async Requests Method | ScraperAPI Documentation"
[5]: https://docs.scraperapi.com/making-requests/customizing-requests/premium-residential-mobile-proxy-pools "Premium Residential/Mobile Proxy Pools | ScraperAPI Documentation"
[6]: https://docs.scraperapi.com/python/making-requests/customizing-requests/sessions?utm_source=chatgpt.com "Sessions"
[7]: https://docs.scraperapi.com/making-requests/customizing-requests/custom-headers "Custom Headers | ScraperAPI Documentation"
[8]: https://docs.scraperapi.com/release-notes/january-2025/generate-screenshots?utm_source=chatgpt.com "Generate Screenshots | ScraperAPI Documentation"
[9]: https://www.scraperapi.com/pricing/ "Compare Plans and Get Started for Free - ScraperAPI Pricing"
[10]: https://docs.scraperapi.com/making-requests/customizing-requests/cost-control?utm_source=chatgpt.com "Cost control"
[11]: https://docs.scraperapi.com/making-requests/customizing-requests/rendering-javascript "Rendering Javascript | ScraperAPI Documentation"
[12]: https://docs.scraperapi.com/python/making-requests/customizing-requests/rendering-javascript/screenshot-capture?utm_source=chatgpt.com "Screenshot Capture | ScraperAPI Documentation"
[13]: https://www.scraperapi.com/solutions/bypass-cloudflare/?utm_source=chatgpt.com "Bypass CloudFlare with the Leading Scraping API"
