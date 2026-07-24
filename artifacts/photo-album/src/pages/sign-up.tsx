import { useState } from "react";
import { Link } from "wouter";
import { signUp } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthCardLogo } from "@/pages/sign-in";
import { AuthLayout } from "@/components/auth/AuthLayout";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignUpPage() {
  // Invite links carry the invited address as ?email= so the invitee signs up
  // with the exact address that auto-consumes their org invite.
  const invitedEmail = new URLSearchParams(window.location.search).get("email") ?? "";
  const [name, setName] = useState("");
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [verifySent, setVerifySent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    // Email verification is required, so signUp creates the account and sends a
    // verification email but does NOT sign the user in. callbackURL is where the
    // verify link lands after confirming.
    const { error: signUpError } = await signUp.email({
      name,
      email,
      password,
      callbackURL: `${basePath}/sign-in?verified=1`,
    });
    setSubmitting(false);
    if (signUpError) {
      setError(signUpError.message ?? "Sign up failed");
      return;
    }
    setVerifySent(true);
  }

  return (
    <AuthLayout>
      <Card className="w-full rounded-2xl border-none shadow-none sm:border sm:shadow-md">
        <CardHeader className="text-center">
          <AuthCardLogo />
          <CardTitle>{verifySent ? "Confirm your email" : "Join Vispix"}</CardTitle>
          <CardDescription>
            {verifySent
              ? "One more step to activate your account"
              : "Create an account to collaborate on your team's marketing photos"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {verifySent ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-muted-foreground">
                We sent a confirmation link to <span className="font-medium">{email}</span>. Click it
                to activate your account, then sign in.
              </p>
              <Link href="/sign-in" className="text-sm font-medium text-primary hover:text-primary/80">
                Back to sign in
              </Link>
            </div>
          ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoComplete="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
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
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating account…" : "Sign up"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
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
