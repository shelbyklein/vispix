import type { AttributionTag } from "@workspace/api-client-react";
import { UsageRightsSection, usageRightsOf, type UsageRightsValue } from "@/components/usage-rights/UsageRights";

// Usage rights on the photo page (#207). Always shown — "Rights not recorded"
// is a state, not an absence. Rights are decided at the album level (the album
// page's pills tag every photo in it), so the review route goes there.
export function AttributionPanel({
  photoTags,
  usageRights,
  albumId,
}: {
  photoTags?: AttributionTag[];
  usageRights?: UsageRightsValue | null;
  albumId?: number | null;
}) {
  return (
    <UsageRightsSection
      rights={usageRightsOf({ usageRights, attributionTags: photoTags })}
      albumId={albumId}
      pillsTestId="photo-attribution-pills"
      pillTestIdPrefix="photo-attribution-pill-"
    />
  );
}
