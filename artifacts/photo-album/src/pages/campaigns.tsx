import { useState } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useCampaigns, useCreateCampaign } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Megaphone, Plus, Loader2, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Campaigns (#192): text briefs an agent turns into ad suggestions.

function NewCampaignDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const { mutate: create, isPending } = useCreateCampaign();

  function handleCreate() {
    if (!name.trim() || !brief.trim()) return;
    create(
      { name: name.trim(), brief: brief.trim() },
      {
        onSuccess: () => {
          setOpen(false);
          setName("");
          setBrief("");
        },
        onError: () => toast({ title: "Failed to create campaign", variant: "destructive" }),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-1.5" data-testid="new-campaign-btn">
          <Plus className="h-4 w-4" /> New campaign
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Campaign name — e.g. Spring Championship Weekend"
            data-testid="campaign-name-input"
          />
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder={
              "The brief the agent works from — what's happening, where and when, and what imagery to use.\n\ne.g. Home game vs. Harborview FC, Saturday May 16, 3pm at Riverside Stadium. Family-friendly crowd push. Use energetic match photography, team colors (teal/white), bold headlines with date and 'tickets at the gate'."
            }
            className="min-h-[160px] text-sm"
            data-testid="campaign-brief-input"
          />
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={!name.trim() || !brief.trim() || isPending} className="gap-1.5">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create campaign
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function CampaignsPage() {
  const { data: campaigns, isLoading } = useCampaigns();

  return (
    <AppLayout>
      <div className="space-y-6" data-testid="campaigns-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
              <Megaphone className="h-6 w-6 text-primary" /> Campaigns
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Write a brief — the assistant turns it into ready-to-use ad suggestions from your library.
            </p>
          </div>
          <NewCampaignDialog />
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading campaigns…
          </div>
        ) : (campaigns ?? []).length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-16 text-center text-muted-foreground">
            <Sparkles className="h-8 w-8" />
            <p className="max-w-md text-sm">
              No campaigns yet. Create one with an event brief — dates, location, imagery notes — and generate ad
              suggestions from it.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(campaigns ?? []).map((c) => (
              <Link
                key={c.id}
                href={`/campaigns/${c.id}`}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50"
                data-testid={`campaign-card-${c.id}`}
              >
                <span className="font-heading text-lg font-semibold text-foreground">{c.name}</span>
                <span className="line-clamp-3 text-sm text-muted-foreground">{c.brief}</span>
                <span className="mt-auto pt-1 text-[11px] text-muted-foreground/70">
                  Updated {new Date(c.updatedAt).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
