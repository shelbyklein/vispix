import { useState } from "react";
import { Link } from "wouter";
import { requestPasswordReset } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCardLogo } from "@/pages/sign-in";
import { AuthLayout } from "@/components/auth/AuthLayout";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // redirectTo is where Better Auth's default flow would land; we build our
    // own link server-side, but pass it anyway for completeness.
    const { error: resetError } = await requestPasswordReset({ email, redirectTo: "/reset-password" });
    setSubmitting(false);
    if (resetError) {
      setError(resetError.message ?? "Something went wrong");
      return;
    }
    // Always show success regardless of whether the email exists, so the form
    // can't be used to probe which addresses have accounts.
    setSent(true);
  }

  return (
    <AuthLayout>
      <Card className="w-full rounded-2xl border-none shadow-none sm:border sm:shadow-md">
        <CardHeader className="text-center">
          <AuthCardLogo />
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>
            {sent ? "Check your inbox" : "We'll email you a link to set a new password"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-muted-foreground">
                If an account exists for <span className="font-medium">{email}</span>, a password
                reset link is on its way. The link expires in 1 hour.
              </p>
              <Link href="/sign-in" className="text-sm font-medium text-primary hover:text-primary/80">
                Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting}>
                {submitting ? "Sending…" : "Send reset link"}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Remember your password?{" "}
                <Link href="/sign-in" className="font-medium text-primary hover:text-primary/80">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
