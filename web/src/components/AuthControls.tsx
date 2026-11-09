import { useEffect, type ReactNode } from "react";
import { SignedIn, SignedOut, UserButton, useAuth } from "@clerk/clerk-react";
import { dark as clerkDark } from "@clerk/themes";
import { setSessionTokenProvider } from "@/lib/api";

export type AccountMenuItem = { label: string; icon: ReactNode; onSelect: () => void };

/**
 * Header auth widget. Also bridges the Clerk session into the API layer:
 * while signed in, every fetch carries a fresh session JWT. Switching team
 * counts as a session change, so the dashboard reloads in the new team.
 */
export function AuthControls({ onOpenLogin, onSessionChange, dark, menu = [] }: {
  onOpenLogin: () => void;
  onSessionChange: (signedIn: boolean, loaded: boolean) => void;
  dark: boolean;
  /** Pages that live under the avatar instead of the tab row. */
  menu?: AccountMenuItem[];
}) {
  const { isSignedIn, isLoaded, getToken, orgId } = useAuth();

  useEffect(() => {
    if (isSignedIn) {
      setSessionTokenProvider(() => getToken());
    } else {
      setSessionTokenProvider(null);
    }
    onSessionChange(!!isSignedIn, isLoaded);
  }, [isSignedIn, isLoaded, getToken, orgId, onSessionChange]);

  return (
    <>
      <SignedOut>
        <button
          type="button"
          onClick={onOpenLogin}
          className="h-8 rounded-md bg-[var(--cta-bg)] px-3.5 text-[13px] font-medium text-[var(--cta-fg)] transition-transform active:scale-[0.98]"
        >
          Log in
        </button>
      </SignedOut>
      <SignedIn>
        <UserButton afterSignOutUrl="/" appearance={dark ? { baseTheme: clerkDark } : undefined}>
          <UserButton.MenuItems>
            {menu.map((item) => (
              <UserButton.Action key={item.label} label={item.label} labelIcon={item.icon} onClick={item.onSelect} />
            ))}
            <UserButton.Action label="manageAccount" />
            <UserButton.Action label="signOut" />
          </UserButton.MenuItems>
        </UserButton>
      </SignedIn>
    </>
  );
}
