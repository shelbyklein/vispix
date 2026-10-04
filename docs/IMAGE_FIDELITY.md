# Image fidelity (#215)

How Create and Campaigns keep brand assets faithful and never silently generate without the inputs a design needs. Plan: `docs/plans/215-asset-fidelity/plan.md`.

## Modes

| Input role | v1 behaviour | Label on the output |
|---|---|---|
| `exact_asset` (logo) | The original file is **composited** onto the generated image by Vispix. The model only chooses *where*. PNG/JPG/WebP used as-is; SVG rasterised with sharp at the target size. | "Logo placed exactly" (+ "at default position" when the placeholder wasn't found) |
| `hero_photo` | Sent to the model as a reference; the model **reinterprets** it. Not pixel-exact. | "Photo reinterpreted by AI", linking the original |
| `style` | Reference only. | — |

Exact text overlays and pixel-exact photo panels are a later phase. Do not imply they exist.

## Placement: placeholder box

1. When an exact logo is requested, the brief asks the model to leave a **flat, solid `#FF00FF` (magenta) rectangle** where the logo should go, sized for the logo's aspect ratio, and to draw no logo itself.
2. After generation, Vispix scans the output for the largest connected region within a tolerance of the key colour (`compose.ts`).
3. Found → the original logo is resized to fit inside that box (aspect ratio preserved, centred) and composited; the rest of the box is filled with the surrounding colour so no magenta remains. Placement `model_placeholder`.
4. Not found → the logo is composited at the default position (bottom-right, ~18% of the width, with margin). Placement `default_corner`.
5. The image **before** compositing is stored as the base image; the final image is what users see and download.

## Revisions

A revision re-generates from the parent's **base** image (store is off; see CLAUDE.md), then re-composites the same logo file revision at the recorded layout unless the revision explicitly changes the logo. Lineage (`parentGenerationId`) and the composition record carry over.

## Missing required inputs

The planner marks inputs a design needs (a hero photo, the primary/requested logo) as **required**. When one is `missing` or `ambiguous`:

**How requirements are computed (`plan.ts`, `requiredInputs` on the plan).** A hero photo is required when the planner proposed a photo query; a logo (`exact_asset`) when it proposed a brand-asset query, or the request itself names the logo ("logo", "wordmark", "brand mark") and nothing attached looks like one. Status: `found` (a photo candidate exists; a logo candidate with high/medium match confidence from #206 ranking), `missing` (no candidates; for a logo, no designated primary when a generic/primary logo was asked for), `ambiguous` (logo candidates exist but the best is low-confidence). Messages are fixed strings, never model text. An attached input of the same role satisfies the requirement client-side.

**Who enforces what.**

- **Create = UI-enforced and server-enforced (when the client sends the plan).** The plan card shows an amber panel per missing/ambiguous input ("Choose a logo…" / "Continue without a logo"); Generate stays disabled until each is attached or acknowledged. The request carries the plan's `requiredInputs` (max 4 entries of `{ role, slot, status, message }`) and `acknowledgedMissing` (known roles `hero_photo` | `exact_asset`; anything else is a 400; de-duplicated and recorded as `grounding.acknowledgedMissing`). The server checks every `requiredInputs` entry whose status is `missing` or `ambiguous`: if the request has no input with that role and the role is not in `acknowledgedMissing`, it generates nothing and returns **409** `{ error: "A required input is missing", code: "input_required", missing: [...the unresolved entries] }` (the client's `InputRequiredError`). Create then re-shows the amber panel. **Caveat:** the server cannot derive requirements itself, so callers that send no `requiredInputs` (MCP, direct API calls, revisions) are not checked; only `acknowledgedMissing` is recorded for them.
- **Campaigns = server-enforced.** Concepts are planned and grounded entirely on the server, so it enforces strictly: a concept whose required inputs can't be grounded is returned with `status: "needs_input"` and `missing: RequiredInput[]`, and **no generation row is created** for it (the old silent "generating without inputs" fallback is gone, including after a grounding error). Required: a hero photo when the concept has a photo query (found = the top retrieval match is attached), the designated primary logo when the concept wants a logo (#206: never an arbitrary brand asset).
- **Continuing a needs_input concept.** `POST /campaigns/:id/generate-concept` with `{ concept, acknowledgedMissing }` (the `concept` is the `resume` object returned alongside a needs_input concept; same permission and rate limit as generating). The server re-grounds it (a photo/logo added since is used), and only roles listed in `acknowledgedMissing` may be skipped — any other missing role still returns `needs_input`. Skipped roles are recorded as `grounding.acknowledgedMissing`. Needs-input concepts are returned by the generate call only; they are not persisted, so reloading the page drops them (generate again to get them back).
- Continuing without is recorded in the generation's `fidelity.grounding.acknowledgedMissing` and shown on the output ("No logo used" / "No photo used").

## Canvases

Supported: `1:1` (1024×1024), `2:3` (1024×1536), `3:2` (1536×1024). Any other requested ratio is rendered on the nearest supported canvas **and recorded** as `formatResolution { requested, rendered, supported: false }`, shown on the output — never relabelled silently. Campaign concepts pass their requested ratio (e.g. `16:9`) as `requestedFormat` and render on the nearest canvas by aspect ratio (`16:9` → `3:2`, `9:16` → `2:3`; unparseable → `1:1`).

## Provenance

Each generation records: model id and settings, inputs (photo/asset ids, names, asset file revision), rights snapshot (#207), composition (asset, revision, layout, placement), photo treatment, grounding acknowledgements, format resolution, and lineage. Generated images stay outside photo analysis and embeddings (#194). Member views keep the #243-audit redaction of hidden-photo details.
