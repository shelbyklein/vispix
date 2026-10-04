import type { AttributionTag } from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";
import { Copyright, Check } from "lucide-react";

// Read-only usage-rights badges for the photo page. Attribution is decided at
// the album level (the album page's Attribution pills tag every photo in the
// album); individual photos display what has been recorded for them.
export function AttributionPanel({ photoTags }: { photoTags?: AttributionTag[] }) {
  const tags = photoTags ?? [];
  if (tags.length === 0) return null;

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
        <Copyright className="h-3.5 w-3.5" />
        Attribution
      </Label>
      <div className="flex flex-wrap gap-1.5" data-testid="photo-attribution-pills">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/30"
            data-testid={`photo-attribution-pill-${tag.id}`}
          >
            <Check className="h-3 w-3 shrink-0" />
            {tag.name}
          </span>
        ))}
      </div>
    </div>
  );
}
