import React, { useEffect, useRef } from "react";
import { BulkUploadProvider } from "@/contexts/BulkUploadContext";
import { PhotoUploadProvider } from "@/contexts/PhotoUploadContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { queryClient } from "@/lib/queryClient";
import "@/lib/active-org"; // registers the X-Organization-Id getter with the API client
import { OrgProvider } from "@/contexts/OrgContext";
import { useSession } from "@/lib/auth-client";
import { AuthGate } from "@/components/auth/AuthGate";
import SignInPage from "@/pages/sign-in";
import SignUpPage from "@/pages/sign-up";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import ContactPage from "@/pages/contact";
import { useGetRegistrationSettings, useGetMe } from "@workspace/api-client-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clears the React Query cache whenever the signed-in user changes,
// so no data leaks between accounts.
function SessionQueryClientCacheInvalidator() {
  const { data: session, isPending } = useSession();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (isPending) return;
    const userId = session?.user.id ?? null;
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
      qc.clear();
    }
    prevUserIdRef.current = userId;
  }, [session, isPending, qc]);

  return null;
}

function SignUpGuard() {
  const { data, isLoading } = useGetRegistrationSettings();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (data && !data.registrationEnabled) {
    return <Redirect to="/" />;
  }
  return <SignUpPage />;
}

function LazyPage({ load }: { load: () => Promise<{ default: React.ComponentType }> }) {
  const [Component, setComponent] = React.useState<React.ComponentType | null>(null);
  useEffect(() => {
    load().then((m) => setComponent(() => m.default));
  }, [load]);
  if (!Component) return <div className="flex min-h-screen items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  return <Component />;
}

// Signed-in landing surface (#135): platform admins land on the superadmin
// panel, everyone else on the dashboard. Sign-in/sign-up redirect to "/" so
// this one component owns the decision.
function LandingRedirect() {
  const { data: me, isLoading } = useGetMe();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  return <Redirect to={me?.role === "admin" ? "/superadmin" : "/dashboard"} />;
}

function AppRoutes() {
  return (
    <QueryClientProvider client={queryClient}>
      <OrgProvider>
      <BulkUploadProvider>
      <PhotoUploadProvider>
      <SessionQueryClientCacheInvalidator />
      <Switch>
        <Route path="/">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LandingRedirect />
              </AuthGate>
              <AuthGate when="signed-out">
                <LazyPage load={() => import("@/pages/home")} />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/dashboard">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/dashboard")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/albums">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/albums")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/albums/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/album-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/bulk-upload">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/bulk-upload")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/photos/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/photo-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/photos">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/photos")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/admin">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/admin")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        {([
          ["/admin/duplicates", () => import("@/pages/admin-duplicates")],
          ["/admin/near-duplicates", () => import("@/pages/admin-near-duplicates")],
          ["/superadmin/registration", () => import("@/pages/admin-registration")],
          ["/admin/ai-services", () => import("@/pages/admin-ai-services")],
          ["/admin/ai-analysis", () => import("@/pages/admin-ai-analysis")],
          ["/admin/embeddings", () => import("@/pages/admin-embeddings")],
          ["/admin/image-optimization", () => import("@/pages/admin-image-optimization")],
          ["/admin/thumbnails", () => import("@/pages/admin-thumbnails")],
          ["/admin/captured-dates", () => import("@/pages/admin-captured-dates")],
          ["/admin/attribution-tags", () => import("@/pages/admin-attribution-tags")],
          ["/admin/mcp-tokens", () => import("@/pages/admin-mcp-tokens")],
          ["/superadmin/organizations", () => import("@/pages/admin-organizations")],
          ["/superadmin/analytics", () => import("@/pages/superadmin-analytics")],
          ["/superadmin", () => import("@/pages/superadmin")],
          ["/admin/organization", () => import("@/pages/admin-organization")],
          ["/admin/billing", () => import("@/pages/admin-billing")],
          ["/admin/members", () => import("@/pages/admin-org-members")],
          ["/superadmin/users", () => import("@/pages/admin-team")],
        ] as const).map(([path, load]) => (
          <Route key={path} path={path}>
            {() => (
              <>
                <AuthGate when="signed-in">
                  <LazyPage load={load} />
                </AuthGate>
                <AuthGate when="signed-out">
                  <Redirect to="/sign-in" />
                </AuthGate>
              </>
            )}
          </Route>
        ))}
        <Route path="/settings">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/settings")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/search">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/search")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/collections">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/collections")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/collections/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/collection-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/projects">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/projects")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/projects/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/project-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/assets">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/assets")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/create">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/create")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/campaigns/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/campaign-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/campaigns">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/campaigns")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/smart-collections">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/smart-collections")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/smart-collections/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/smart-collection-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/people">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/people")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/people/:id">
          {() => (
            <>
              <AuthGate when="signed-in">
                <LazyPage load={() => import("@/pages/person-detail")} />
              </AuthGate>
              <AuthGate when="signed-out">
                <Redirect to="/sign-in" />
              </AuthGate>
            </>
          )}
        </Route>
        <Route path="/sign-in" component={SignInPage} />
        <Route path="/sign-up" component={SignUpGuard} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/contact" component={ContactPage} />
        <Route>
          <LazyPage load={() => import("@/pages/not-found")} />
        </Route>
      </Switch>
      <Toaster />
      </PhotoUploadProvider>
      </BulkUploadProvider>
      </OrgProvider>
    </QueryClientProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <WouterRouter base={basePath}>
        <AppRoutes />
      </WouterRouter>
    </ThemeProvider>
  );
}

export default App;
