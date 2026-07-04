import { useEffect } from "react";
import { SignIn, SignUp } from "@clerk/clerk-react";
import { GraphAnimation } from "@/components/GraphAnimation";

export function LoginDrawer({ open, mode, onClose, dark, prefillEmail }: {
  open: boolean;
  mode: "sign-in" | "sign-up";
  onClose: () => void;
  dark: boolean;
  prefillEmail?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Sign in to Trove">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30 backdrop-blur-[2px] transition-opacity"
      />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-hidden border-l bg-background shadow-2xl">
        <GraphAnimation dark={dark} density={36} className="pointer-events-none absolute inset-0 h-full w-full opacity-70" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/20 via-background/55 to-background/85" />

        <div className="relative z-10 flex items-center justify-between px-6 pt-5">
          <span className="font-serif text-lg tracking-tight">Trove</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sign in"
            className="flex size-8 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="relative z-10 flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
          {mode === "sign-up" ? (
            <SignUp
              routing="hash"
              signInUrl="#/sign-in"
              initialValues={prefillEmail ? { emailAddress: prefillEmail } : undefined}
              appearance={{ elements: { rootBox: "mx-auto", cardBox: "shadow-xl" } }}
            />
          ) : (
            <SignIn
              routing="hash"
              signUpUrl="#/sign-up"
              appearance={{ elements: { rootBox: "mx-auto", cardBox: "shadow-xl" } }}
            />
          )}
        </div>
      </aside>
    </div>
  );
}
