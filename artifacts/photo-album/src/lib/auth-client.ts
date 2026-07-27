import { createAuthClient } from "better-auth/react";
import { multiSessionClient } from "better-auth/client/plugins";

// Requests go through the Vite /api proxy in dev (same-origin cookies).
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  // Account switching (#191): list/switch/revoke this browser's signed-in
  // sessions via authClient.multiSession.*
  plugins: [multiSessionClient()],
});

export const { useSession, signIn, signUp, signOut, requestPasswordReset, resetPassword } = authClient;
