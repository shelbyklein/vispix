# Vispix — Market & Marketing Strategy

_Drafted 2026-07-25. Living document — update as channels are tested and metrics come in._

## What Vispix is (for positioning purposes)

A **lightweight AI-native DAM** (digital asset management) priced far below enterprise DAMs
(Bynder, Brandfolder): multi-tenant orgs, AI descriptions + quality scoring, semantic search,
usage-rights tracking, people tagging, brand assets (logos/fonts), and an MCP gateway so AI
agents can query the library directly.

### The one sentence

> **Vispix — the AI photo library for teams that shoot a lot and can never find anything.**
> Search by meaning, track usage rights, and let your AI assistant pull cleared, high-quality
> shots for you.

Lead with the *pain* (thousands of unsearchable event photos + consent risk), not the tech.
The MCP/agent angle is the differentiator headline for the marketer audience; rights/consent
is the urgency headline for sports/schools.

---

## Target markets

### Strongest fits

1. **Sports clubs, leagues, and governing bodies** _(origin story — USA Archery)_
   - Thousands of event photos per season, shot by volunteers/contractors, dumped into
     folders nobody can search.
   - People tagging (athletes), usage-rights tracking (minors' photos, media releases),
     and "find me a hero shot of X celebrating" semantic search map exactly to their workflow.
   - The org model fits federations: national body → state chapters → clubs, each an org.
   - Youth-sports photo consent/rights is a genuine compliance pain — attribution tags are
     quietly a legal tool.

2. **Small marketing teams / solo marketers at SMBs (5–50 employees)**
   - "Give your marketing assets superpowers" positioning is theirs: one marketing person
     sitting on 10k unsorted photos who needs "the good one, cleared for social, in portrait
     crop" in 30 seconds.
   - Quality scoring + `minQuality` filter is a direct hero-shot picker; flaw chips kill the
     "why is this one blurry" review loop.
   - They'll never pay Bynder's ~$1k+/mo; the Pro tier is an easy yes.

3. **Nonprofits, churches, schools, universities**
   - Event-heavy, volunteer photographers, zero DAM budget, high consent-sensitivity
     (schools especially). Often literally the same buyers as sports (athletic directors,
     communications staff).

4. **Agencies & freelance photographers serving clients**
   - Multi-tenancy is the killer feature: one org per client, isolated libraries, client seats.
   - Deliver searchable, rights-tracked libraries as a value-add instead of a Dropbox link.

### The differentiated wedge

5. **AI-agent-first content teams** — the MCP gateway means a marketer's Claude can *search
   the brand library itself*: "find three cleared photos of smiling kids for the newsletter"
   happens inside their AI assistant, with quality scores and rights attached. Almost no DAM
   has this today. As agent workflows normalize, "your asset library, queryable by your AI"
   could become the headline rather than a feature — and #167 (AI image generation using
   library assets) completes that loop.

### Weaker fits (don't chase)

- **Consumers/families** — Google/Apple Photos own this for free.
- **Enterprise** — procurement, SSO/SAML, compliance certs not in place.
- **High-volume pro photographers' culling workflow** — Lightroom territory; they'd use
  Vispix for *delivery*, not editing.

### Beachhead

**Youth/amateur sports organizations**: domain credibility, a live flagship user, the
rights/consent angle gives urgency beyond convenience, and they cluster — one federation win
cascades to its clubs. Market #2 (SMB marketers) grows naturally from there, since club
marketers *are* small marketing teams.

---

## Strategy

Shaped around reality: solo founder, strong AI infrastructure already built, near-zero ad
budget, and "USA Archery runs on this" as the best story. Core idea: **pick the sports-org
beachhead, make content + product the growth engines, and automate everything that isn't a
human relationship.**

### Funnel — the bottom half is already built

| Stage | Asset (already built) | Gap to fill |
|---|---|---|
| Discover | — | SEO pages, content, community presence |
| Land | Landing page (#157) | Vertical landing pages, case study |
| Sign up | Free tier + Stripe live (#141) | Capture *source* (UTM) at signup |
| Activate | 12-step onboarding tour (#148) | Email nudges for stalled users |
| Upgrade | Storage-gated billing | Usage-triggered upgrade emails |
| Refer | — | Later; skip for now |

Marketing effort goes almost entirely to the top (discovery) plus automated email glue in
the middle.

### Channels, ranked

1. **Case study + direct outreach** _(highest ROI, human-powered)_
   One great "How USA Archery organized 40,000 photos" page. Then personally email/DM 10
   sports federations and state associations a week. This is the one thing that should NOT
   be automated (relationship-building; mass cold email = spam/compliance risk). Automation
   *assists*: prospect research lists, draft personalization.
2. **Programmatic SEO** _(highest ROI, fully automatable)_
   Dozens of vertical pages: "photo management for swim teams / gymnastics clubs / school
   athletics / youth soccer / nonprofits…" — same template, AI-drafted copy per vertical,
   human-skimmed. Long-tail searches like "organize team photos usage rights" have weak
   competition.
3. **Editorial content** _(automatable with review)_
   1–2 posts/week: consent & photo-rights guides for youth sports (compliance content earns
   links), AI-search explainers, "Bynder/Brandfolder alternative" comparison pages
   (high-intent searches).
4. **Community** _(semi-manual)_
   Sports-admin Facebook groups, r/sportsphotography, school-comms Slack groups. Share the
   free tool + rights guides; don't pitch.
5. **Product-led**
   Free tier is the ad. Later: public shared-album pages with tasteful "Powered by Vispix"
   (viral loop — every gallery a club shares markets the product).

### The automation layer (buildable in this codebase)

- **A. UTM/source attribution** — capture `utm_*` + referrer at signup, store on the org,
  surface in platform analytics (#155). _Without this nothing else is measurable. Build first._
- **B. Marketing site content engine** — blog + programmatic vertical pages on vispix.dev,
  statically generated; a cron/workflow drafts posts with the existing AI providers into a
  review queue (founder approves → publish). Nothing publishes without a human click.
- **C. Lifecycle email automation** — Elastic Email + event data already exist: welcome
  series, "stalled onboarding" nudges (tour step data exists), "you're at 80% storage"
  upgrade prompts, weekly founder digest of signups/activity.
- **D. Social drafts** — turn each shipped feature/blog post into ready-to-paste X/LinkedIn
  drafts (draft only; founder posts).
- **E. Prospect research assistant** — a workflow that builds a spreadsheet of clubs and
  federations with contact pages for *manual* outreach (no auto-sending).

**Build order: A → C → B.** A is the prerequisite for measuring anything; C converts users
already arriving; B fills the top of the funnel. D and E ride along cheaply afterward.

### Cadence + metrics

- **Weekly founder time (~2h):** approve queued content, send 10 personal outreach emails,
  post 2 social drafts. Everything else runs itself.
- **Metrics that matter:** signups by source → activation rate (finished onboarding tour) →
  paid conversions. Ignore vanity traffic.
