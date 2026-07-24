import { useState } from "react";
import { Link } from "wouter";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthLayout } from "@/components/auth/AuthLayout";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function AuthCardLogo() {
  return (
    <div className="flex justify-center mb-2">
      <img src={`${basePath}/vispix.png`} alt="Vispix" className="h-10 w-auto rounded-md" />
    </div>
  );
}

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set by the email-verification link's callbackURL after a successful confirm.
  const justVerified = new URLSearchParams(window.location.search).get("verified") === "1";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error: signInError } = await signIn.email({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? "Sign in failed");
      return;
    }
    // Full-page navigation so the session cookie is picked up fresh —
    // a client-side route change can race the useSession store update.
    window.location.assign(`${basePath}/`);
  }

  return (
    <AuthLayout>
      <Card className="w-full rounded-2xl border-none shadow-none sm:border sm:shadow-md">
        <CardHeader className="text-center">
          <AuthCardLogo />
          <CardTitle>Welcome back to Vispix</CardTitle>
          <CardDescription>Sign in to start picking photos for marketing</CardDescription>
        </CardHeader>
        <CardContent>
          {justVerified && (
            <p className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
              Email confirmed — you can sign in now.
            </p>
          )}
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
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="text-right">
              <Link href="/forgot-password" className="text-sm font-medium text-primary hover:text-primary/80">
                Forgot password?
              </Link>
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{" "}
              <Link href="/sign-up" className="font-medium text-primary hover:text-primary/80">
                Sign up
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
