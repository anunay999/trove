import { GraphAnimation } from "@/components/GraphAnimation";

/** Shown to signed-in users whose account has not been approved yet. */
export function WaitlistGate({ email, dark }: { email: string | null; dark: boolean }) {
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden px-6">
      <GraphAnimation dark={dark} density={34} className="pointer-events-none absolute inset-0 h-full w-full opacity-40" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-background/30 via-background/70 to-background" />
      <div className="relative z-10 w-full max-w-md rounded-lg border bg-card/90 p-8 text-center backdrop-blur">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Early access</p>
        <h2 className="mt-3 font-serif text-2xl tracking-tight">You're on the waitlist</h2>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          {email ? <>We have <span className="font-medium text-foreground">{email}</span> down.</> : "Your account is registered."}{" "}
          Trove is opening up gradually; you'll get access as soon as a seat frees up. Nothing else to do here — your memory graph will be waiting.
        </p>
      </div>
    </div>
  );
}
