import { useState, type ReactNode } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

// Type-to-confirm gate for irreversible platform actions (issue #196). A plain
// "are you sure?" is too easy to click through when the consequence is an
// entire customer's library, so the operator has to type the record's own
// identifier. The server checks the same phrase — this is the ergonomic half of
// the guard, not the whole of it.
export function DangerConfirmDialog({
  trigger,
  title,
  description,
  phrase,
  phraseLabel,
  confirmLabel,
  pending,
  onConfirm,
  testId,
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  // The exact string the operator must type (org slug / user email).
  phrase: string;
  phraseLabel: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: (phrase: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === phrase;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Never carry a satisfied confirmation into the next time it opens.
    if (!next) setTyped("");
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="danger-confirm-input" className="text-xs">
            {phraseLabel}
          </Label>
          <Input
            id="danger-confirm-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={phrase}
            autoComplete="off"
            spellCheck={false}
            data-testid={testId ? `${testId}-input` : undefined}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!matches || pending}
            // Keep the dialog mounted while the request is in flight; the
            // caller closes it on success via its own state.
            onClick={(e) => {
              e.preventDefault();
              if (!matches || pending) return;
              onConfirm(typed.trim());
              handleOpenChange(false);
            }}
            className="bg-destructive hover:bg-destructive/90"
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
