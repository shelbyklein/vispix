# Collection suggestions (AI recommendations)

Issue #212. One persistent state per (photo, collection), owned by the API. The
photo details page and the lightbox sidebar both render the list the API returns
(`suggestedCollections` / `suggestedNewCollections` on a photo) and nothing else.
There is no client-side recommendation logic: the former word-overlap pills
(`aiSuggestions.ts`) were removed.

## States

```
              AI analysis (source=model)
                        |
                        v
                    [pending] --accept--> [accepted]  (review)   -> membership added once
                        |  \
                        |   `--dismiss--> [dismissed] (review)   -> stays dismissed
                        |
                        `--human adds photo to the collection--> [accepted] (manual)
```

- **pending**: shown in both surfaces with its reason and provenance.
- **accepted / review**: the user clicked accept; the photo was added to the
  collection (one `photo_collections` row, any negative example for the pair removed).
- **accepted / manual**: the photo was added to the collection by hand
  (`POST /collections/:id/photos`, the pill toggles). A pending suggestion for the
  pair resolves to accepted with `resolution = 'manual'`; membership is not duplicated.
- **dismissed**: the user rejected it. Never shown again for that photo+collection.
- **manual membership without a suggestion** is just a `photo_collections` row. It is
  unaffected by suggestions. Removing a photo from a collection later does not revive
  or delete the suggestion row (an accepted row stays accepted, a dismissed row dismissed).

A suggestion for a collection the photo is already in is never served (membership wins),
and only org collections of kind `collection` are served (people stay manual /
similarity-driven; smart-collection negative examples stay in `collection_negative_photos`).

## Decisions are idempotent

`POST /photos/:id/suggestions/:collectionId/{accept,dismiss}` and the
`new-collection-suggestions/:suggestionId/{accept,dismiss}` twins:

| Existing state | Same decision | Opposite decision | No row |
| --- | --- | --- | --- |
| pending | applied (200) | applied (200) | |
| accepted / dismissed | no-op (200) | 409 | 404 |

Accepting a new-collection suggestion creates its collection in the same transaction
as the status change, so a repeat accept can never create a second collection.
The same role rules as before apply (org manager, photo uploader, or collection
creator), hidden photos are 404 for members, and every query is scoped to the caller's org.

## Re-analysis

`runAndRecordPhotoAnalysis` clears only **pending** rows for the photo, then offers the
model's current picks:

- a collection with an existing accepted/dismissed row is not touched (`ON CONFLICT DO NOTHING`);
  **a dismissal is never resurrected automatically**;
- a collection the photo is already a member of is not offered;
- a new-collection name already accepted or dismissed for this photo (compared
  case- and whitespace-insensitively) is not offered again;
- evaluation scores and the description update as before.

## Provenance

Each suggestion row records `source` (`model` = AI analysis, `heuristic` = word-overlap
hint, reserved and never written today), `provider`, `model` (model id),
`analysisVersion` (`ANALYSIS_VERSION` in `lib/collectionSuggestions.ts`; bump it when
the suggestion prompt/logic changes materially), `reason`, and for decided rows
`resolution` (`review` | `manual`), `decidedAt`, `decidedById`.
A future owner decision may allow re-offering a dismissed suggestion on materially new
evidence (for example a newer `analysisVersion`); that is deliberately **not** implemented.

## Deletion and visibility

- Deleting a photo or a collection cascades its suggestion rows (FKs).
- Hidden photos (#218) are invisible to members everywhere, including suggestion reads
  and decisions; org owners/admins still see and decide them.
- Deleting a user sets `decided_by_id` to null; the decision stays.

## Existing-data mapping (migration 0039)

Additive columns only; no row is deleted and no membership or negative example is touched.

| Existing row | After migration |
| --- | --- |
| any suggestion row | `source = 'model'` (all legacy rows came from AI analysis); `provider`, `model`, `analysis_version`, `reason`, `decided_at`, `decided_by_id` are null (unknown) |
| `accepted` or `dismissed` | status unchanged, `resolution = 'review'` |
| `pending` and the photo is already in the collection | `status = 'accepted'`, `resolution = 'manual'` (membership already existed) |
| other `pending` | unchanged; shown with a generic reason until the next analysis refreshes it |
| `photo_new_collection_suggestions` | same source/resolution mapping as above |
| `photo_collections`, `collection_negative_photos` | untouched |

Rollback: the new columns are nullable/defaulted, so older code ignores them. The two
status flips in step 3 only move a pending row to accepted where membership already exists.
