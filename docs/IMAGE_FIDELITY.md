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

- Create: Generate is disabled until the person chooses an input or picks "Continue without". The API enforces the same rule: `POST /image-generation/generate` returns

  ```json
  { "error": "…", "code": "input_required", "missing": [{ "role": "exact_asset", "slot": "Primary logo", "status": "missing", "message": "…" }] }
  ```

  with status **409** unless the request lists the role in `acknowledgedMissing`.
- Campaigns: a concept whose required inputs can't be grounded is returned with `status: "needs_input"` instead of being rendered without inputs.
- Continuing without is recorded in the generation's `fidelity.grounding.acknowledgedMissing` and shown on the output ("No logo used" / "No photo used").

## Canvases

Supported: `1:1` (1024×1024), `2:3` (1024×1536), `3:2` (1536×1024). Any other requested ratio is rendered on the nearest supported canvas **and recorded** as `formatResolution { requested, rendered, supported: false }`, shown on the output — never relabelled silently.

## Provenance

Each generation records: model id and settings, inputs (photo/asset ids, names, asset file revision), rights snapshot (#207), composition (asset, revision, layout, placement), photo treatment, grounding acknowledgements, format resolution, and lineage. Generated images stay outside photo analysis and embeddings (#194). Member views keep the #243-audit redaction of hidden-photo details.
