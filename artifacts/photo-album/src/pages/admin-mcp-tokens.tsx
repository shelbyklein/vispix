import { useState } from "react";
import {
  useMcpTokens,
  useCreateMcpToken,
  useDeleteMcpToken,
  type McpTokenListItem,
} from "@workspace/api-client-react";
import { AdminSectionShell } from "@/components/admin/AdminSectionShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { KeyRound, Loader2, Plus, Trash2, Copy, Check, TriangleAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format-date";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-8 gap-1.5 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — user can select manually */
        }
      }}
      aria-label={`Copy ${label}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// Shown once, right after creation — the raw token is never retrievable again.
function NewTokenReveal({
  token,
  publicBaseUrl,
  onDismiss,
}: {
  token: string;
  publicBaseUrl: string | null;
  onDismiss: () => void;
}) {
  const urlForm = publicBaseUrl ? `${publicBaseUrl}/${token}/mcp` : null;
  const bearerCmd = publicBaseUrl
    ? `claude mcp add --scope user --transport http vispix ${publicBaseUrl}/mcp --header "Authorization: Bearer ${token}"`
    : null;

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 space-y-3" data-testid="new-token-reveal">
      <div className="flex items-start gap-2">
        <TriangleAlert className="h-4 w-4 text-warning-foreground shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold text-foreground">Copy this token now — it won't be shown again.</p>
          <p className="text-muted-foreground text-xs mt-0.5">
            Stored hashed on the server; only you have the raw value from here on.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs font-mono" data-testid="new-token-value">
          {token}
        </code>
        <CopyButton value={token} label="token" />
      </div>

      {urlForm && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">claude.ai custom connector URL (URL is the secret):</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs font-mono">{urlForm}</code>
            <CopyButton value={urlForm} label="connector URL" />
          </div>
        </div>
      )}

      {urlForm && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            ChatGPT connector URL (Settings → Apps &amp; Connectors → Create, authentication "None"):
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs font-mono">{urlForm}</code>
            <CopyButton value={urlForm} label="ChatGPT connector URL" />
          </div>
        </div>
      )}

      {bearerCmd && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Claude Code (another machine):</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs font-mono">{bearerCmd}</code>
            <CopyButton value={bearerCmd} label="command" />
          </div>
        </div>
      )}

      <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onDismiss} data-testid="dismiss-new-token">
        Done
      </Button>
    </div>
  );
}

function TokenRow({ token, onDelete, deleting }: { token: McpTokenListItem; onDelete: (id: number, label: string) => void; deleting: boolean }) {
  return (
    <div className="flex items-center gap-3 px-5 py-3" data-testid={`mcp-token-row-${token.id}`}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{token.label}</p>
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">{token.tokenPrefix}…</code>
          {" · "}created {formatDate(token.createdAt)}
          {token.createdByName ? ` by ${token.createdByName}` : ""}
          {" · "}
          {token.lastUsedAt ? `last used ${formatDate(token.lastUsedAt)}` : "never used"}
        </p>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" disabled={deleting} aria-label={`Revoke ${token.label}`} data-testid={`revoke-mcp-token-${token.id}`}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke "{token.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Any client using this token loses access immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => onDelete(token.id, token.label)}
              className="bg-destructive hover:bg-destructive/90"
              data-testid={`confirm-revoke-mcp-token-${token.id}`}
            >
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function AdminMcpTokensPage() {
  const { toast } = useToast();
  const { data: tokens, isLoading } = useMcpTokens();
  const { mutate: createToken, isPending: creating } = useCreateMcpToken();
  const { mutate: deleteToken, isPending: deleting } = useDeleteMcpToken();

  const [label, setLabel] = useState("");
  const [reveal, setReveal] = useState<{ token: string; publicBaseUrl: string | null } | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = label.trim();
    if (!name) return;
    createToken(name, {
      onSuccess: (res) => {
        setLabel("");
        setReveal({ token: res.token, publicBaseUrl: res.publicBaseUrl });
        toast({ title: `Token "${name}" created` });
      },
      onError: () => toast({ title: "Failed to create token", variant: "destructive" }),
    });
  }

  function handleDelete(id: number, name: string) {
    deleteToken(id, {
      onSuccess: () => toast({ title: `Revoked "${name}"` }),
      onError: () => toast({ title: "Failed to revoke token", variant: "destructive" }),
    });
  }

  return (
    <AdminSectionShell
      title="MCP Access Tokens"
      icon={KeyRound}
      description="Tokens that let external AI clients (claude.ai connectors, ChatGPT connectors, Claude Code on other machines) reach the photo library through the remote MCP gateway. Generate one per client so you can revoke individually."
    >
      <div className="rounded-xl border border-border bg-card overflow-hidden max-w-2xl">
        <div className="px-5 py-4 border-b border-border space-y-3">
          <form onSubmit={handleCreate} className="flex gap-2" data-testid="create-mcp-token-form">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (e.g. Shelby's ChatGPT)…"
              className="h-9 flex-1"
              maxLength={80}
              disabled={creating}
              data-testid="new-mcp-token-input"
            />
            <Button type="submit" size="sm" className="h-9 gap-1.5" disabled={creating || !label.trim()} data-testid="create-mcp-token-btn">
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Generate
            </Button>
          </form>
          {reveal && (
            <NewTokenReveal token={reveal.token} publicBaseUrl={reveal.publicBaseUrl} onDismiss={() => setReveal(null)} />
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-1.5 px-5 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading tokens…
          </div>
        ) : !tokens || tokens.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No tokens yet. Generate one above to connect an external client.
          </p>
        ) : (
          <div className="divide-y divide-border" data-testid="mcp-tokens-list">
            {tokens.map((token) => (
              <TokenRow key={token.id} token={token} onDelete={handleDelete} deleting={deleting} />
            ))}
          </div>
        )}
      </div>
    </AdminSectionShell>
  );
}
