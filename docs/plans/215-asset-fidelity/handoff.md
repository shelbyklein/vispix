# #215 handoff — coordinator instructions

For the coordinator (Claude Opus 5.5) running [plan.md](plan.md). This is not a dispatch; lanes start only after Shelby says "now".

## Baseline

- Repository `shelbyklein/vispix`, branch `dev`; baseline revision is the commit that adds this handoff (record it when starting).
- Issue #215, Tracker Trapper plan for #215 (IDs `TT-VPX-FIDELITY-01..07`).
- Local test Postgres `127.0.0.1:5439` (postgres/postgres): `vispix_test` (integration), `vispix_test_a` (Lane A), `vispix_test_b` (Lane B). Node/pnpm: `export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH`.

## Step 0 — coordinator commits the shared contract (before lanes)

Commit to `dev`:
- `lib/api-client-react/src/create.ts` types:
  - `GenerationPlan.requiredInputs: { role: "hero_photo" | "exact_asset"; slot: string; status: "found" | "missing" | "ambiguous"; message: string }[]`
  - generate request: `acknowledgedMissing?: ("hero_photo" | "exact_asset")[]`
  - generation record: `composition: { mode: "exact_logo"; assetId: number; assetName: string; assetRevision: string; layout: { x: number; y: number; width: number; height: number }; placement: "model_placeholder" | "default_corner" } | null`, `photoTreatment: "reinterpreted" | null`, `grounding: { acknowledgedMissing: string[] }`, `format: { requested: string; rendered: string; supported: boolean }`, `provenance: { model: string | null; settings: Record<string, unknown> }`
  - campaign generate result per concept: `status: "generated" | "needs_input"`, `missing?: string[]`
- `docs/IMAGE_FIDELITY.md`: the decisions table from plan.md, the placeholder approach, the 409 `input_required` error shape `{ error, code: "input_required", missing: [...] }`.
- Fixtures under `artifacts/api-server/src/lib/__tests__/fixtures/fidelity/`: a small logo PNG with transparency, the same logo as SVG, a synthetic "model output" PNG containing a solid placeholder box in the key colour, and one without.

## Lanes (Claude Sonnet 5.5 each, isolated worktrees from the Step-0 commit)

### Lane A — composition, provenance, revisions, formats (owns)
- New `artifacts/api-server/src/lib/imageGeneration/compose.ts` (placeholder detection, SVG rasterise, composite, layout).
- `orchestrate.ts`, `openaiImage.ts`, `lib/db/src/schema/imageGeneration.ts` + migration `0041` (additive), new `lib/imageGeneration/provenance.ts` exposing `generationProvenance(row, { canSeeHidden })`, `artifacts/photo-album/src/pages/generations.tsx` (provenance panel, labels).
- Must keep the #243-audit redaction (`lib/imageGeneration/redact.ts`) for members.
- Does NOT edit `routes/imageGeneration.ts`, `plan.ts`, `campaignSuggestions.ts`, `create.tsx`, `campaign-detail.tsx`. Ask the coordinator to wire `generationProvenance` into `serializeGeneration` at integration.

### Lane B — required-input resolution (owns)
- `plan.ts` (`requiredInputs`), `campaignSuggestions.ts` (no ungrounded fallback; `needs_input`; unsupported-format labelling), `routes/imageGeneration.ts` (`acknowledgedMissing` validation → 409 `input_required`), `artifacts/photo-album/src/pages/create.tsx`, `campaign-detail.tsx`.
- Does NOT edit `orchestrate.ts`, `compose.ts`, schema/migrations, `generations.tsx`.

### Rules for both lanes
- No GitHub changes, no push, no ssh/prod/dev, **no AI-provider calls** (mock `openaiImage.generateImage`, the planner's OpenAI call, and `embedQuery` as existing tests do).
- No dependency/lockfile changes (sharp is already present).
- Stop and report on conflicts; never reset or overwrite others' work.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Report: commits, files, tests (written first and seen failing), typecheck + suite results, open questions.

## Integration (coordinator)

1. Review each lane's diff; integrate Lane A first (schema), then Lane B; wire `generationProvenance` into `serializeGeneration`.
2. After each merge: `pnpm install --frozen-lockfile`, migrate `vispix_test`, `pnpm run typecheck`, full suites, web + api builds.
3. Local harness screenshots (synthetic, mocked provider) → `docs/plans/215-asset-fidelity/after-*.png`.
4. Open a PR into `dev` via REST; tick FIDELITY boxes as each check passes (Tracker Trapper + issue).
5. Dev-stack demo (FIDELITY-06) per plan; real-provider run only with spend authorization (FIDELITY-04).
6. Production release only with separate authorization (FIDELITY-07).
