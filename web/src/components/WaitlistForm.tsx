import { useState } from "react";

type WaitlistFormProps = {
  onJoin: (email?: string) => void;
  /** Distinguishes the hero and footer instances, which are on the page together. */
  idPrefix: string;
};

/**
 * Email and action in one bar.
 *
 * The visible "Work email" label is redundant next to the placeholder, so it is
 * kept for screen readers only rather than shown twice.
 */
export function WaitlistForm({ onJoin, idPrefix }: WaitlistFormProps) {
  const [email, setEmail] = useState("");
  const id = `${idPrefix}-email`;

  return (
    <form
      className="flex w-full flex-col gap-1.5 rounded-xl border border-border bg-[var(--card)]/70 p-1.5 backdrop-blur transition-colors focus-within:border-[var(--signal)] sm:flex-row sm:items-center"
      onSubmit={(event) => {
        event.preventDefault();
        onJoin(email.trim() || undefined);
      }}
    >
      <label className="sr-only" htmlFor={id}>
        Work email
      </label>
      <input
        id={id}
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
        autoComplete="email"
        className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="submit"
        className="h-10 shrink-0 whitespace-nowrap rounded-lg bg-[var(--cta-bg)] px-4 text-sm font-semibold text-[var(--cta-fg)] transition-opacity hover:opacity-90 active:opacity-80"
      >
        Join waitlist
      </button>
    </form>
  );
}
