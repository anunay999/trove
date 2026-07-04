import { useEffect } from "react";
import { SignedIn, SignedOut, UserButton, useAuth } from "@clerk/clerk-react";
import { setSessionTokenProvider } from "@/lib/api";

/**
 * Header auth widget. Also bridges the Clerk session into the API layer:
 * while signed in, every fetch carries a fresh session JWT.
 */
export function AuthControls({ onOpenLogin, onSessionChange }: {
  onOpenLogin: () => void;
  onSessionChange: (signedIn: boolean) => void;
}) {
  const { isSignedIn, getToken } = useAuth();

  useEffect(() => {
    if (isSignedIn) {
      setSessionTokenProvider(() => getToken());
    } else {
      setSessionTokenProvider(null);
    }
    onSessionChange(!!isSignedIn);
  }, [isSignedIn, getToken, onSessionChange]);

  return (
    <>
      <SignedOut>
        <button
          type="button"
          onClick={onOpenLogin}
          className="h-8 rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-transform active:scale-[0.98]"
        >
          Log in
        </button>
      </SignedOut>
      <SignedIn>
        <UserButton afterSignOutUrl="/" />
      </SignedIn>
    </>
  );
}
