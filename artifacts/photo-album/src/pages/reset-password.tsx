import { useState } from "react";
import { Link } from "wouter";
import { resetPassword } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCardLogo } from "@/pages/sign-in";
import { AuthLayout } from "@/components/auth/AuthLayout";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function ResetPasswordPage() {
  // Better Auth puts the reset token in the query string; read it directly so
  // this works regardless of the router base.
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    setSubmitting(true);
    const { error: resetError } = await resetPassword({ newPassword: password, token });
    setSubmitting(false);
    if (resetError) {
      setError(resetError.message ?? "This reset link is invalid or has expired");
      return;
    }
    setDone(true);
  }

  return (
    <AuthLayout>
      <Card className="w-full rounded-2xl border-none shadow-none sm:border sm:shadow-md">
        <CardHeader className="text-center">
          <AuthCardLogo />
          <CardTitle>Set a new password</CardTitle>
          <CardDescription>
            {done ? "Password updated" : "Choose a new password for your account"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!token ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-destructive">This reset link is missing its token.</p>
              <Link href="/forgot-password" className="text-sm font-medium text-primary hover:text-primary/80">
                Request a new link
              </Link>
            </div>
          ) : done ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-muted-foreground">
                Your password has been updated. You can now sign in with it.
              </p>
              <Button onClick={() => window.location.assign(`${basePath}/sign-in`)}>Go to sign in</Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                {submitting ? "Updating…" : "Update password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
