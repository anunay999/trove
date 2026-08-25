import type { NodeType } from "@/lib/api";

/**
 * A 2026 agent-workflow graph:
 * agents share context, remember decisions, learn from failures,
 * and keep old beliefs visible when they are superseded.
 */

export type Seed = {
  id: string;
  title: string;
  type: NodeType;
  detail: string;
  source?: string;
  retiredBy?: string;
};

export const SEEDS: Seed[] = [
  {
    id: "acme",
    title: "Acme launch",
    type: "project",
    detail:
      "The shared context behind the launch: decisions, research, owners, open work, and everything the agents need to continue.",
  },
  {
    id: "launch-date-current",
    title: "Launch on September 12",
    type: "decision",
    detail:
      "The current launch date after customer research exposed friction in onboarding.",
    source: "launch-plan.md",
  },
  {
    id: "launch-date-old",
    title: "Launch on August 30",
    type: "decision",
    detail:
      "The original launch date. It stayed on the graph after the plan changed.",
    source: "launch-plan-v1.md",
    retiredBy: "Launch on September 12",
  },
  {
    id: "onboarding-friction",
    title: "New users get stuck during onboarding",
    type: "claim",
    detail:
      "Customer interviews showed that users could not tell what the agent had access to.",
    source: "customer-research.md",
  },
  {
    id: "pricing-update",
    title: "Clarify pricing before launch",
    type: "decision",
    detail:
      "Pricing needs to explain what is included, what is metered, and what requires an add-on.",
    source: "product-review.md",
  },
  {
    id: "priya",
    title: "Priya",
    type: "person",
    detail:
      "Owns the launch, approved the date change, and is responsible for the onboarding decision.",
  },
  {
    id: "previous-agent",
    title: "Claude Code session",
    type: "entity",
    detail:
      "The previous agent investigated the launch blocker before the current session began.",
  },
  {
    id: "current-agent",
    title: "Codex session",
    type: "entity",
    detail:
      "The current agent picks up the work without needing the previous session explained again.",
  },
  {
    id: "stripe-migration",
    title: "Stripe migration",
    type: "project",
    detail:
      "A long-running migration shared between multiple coding agents.",
  },
  {
    id: "duplicate-event",
    title: "Duplicate webhook event IDs",
    type: "claim",
    detail:
      "The previous agent found that retries were creating duplicate event IDs.",
    source: "incident-2026-04-17.md",
  },
  {
    id: "webhook-fix",
    title: "Webhook idempotency fix",
    type: "decision",
    detail:
      "Store the provider event ID before processing so retries become safe.",
    source: "github.com/acme/stripe-migration/issues/184",
  },
  {
    id: "staging",
    title: "Fix deployed to staging",
    type: "claim",
    detail:
      "The fix passed the retry test in staging and is ready for review.",
    source: "deployment-2026-04-18.md",
  },
  {
    id: "repo-rules",
    title: "Repository conventions",
    type: "project",
    detail:
      "Rules agents need every time they work in this repository.",
  },
  {
    id: "pnpm",
    title: "Use pnpm, never npm",
    type: "pattern",
    detail:
      "The repository uses pnpm to keep the lockfile stable across agents.",
    source: "CONTRIBUTING.md",
  },
  {
    id: "no-legacy",
    title: "Never edit /legacy",
    type: "pattern",
    detail:
      "The folder is frozen. Agents should create new code elsewhere.",
    source: "AGENTS.md",
  },
  {
    id: "playwright",
    title: "Run Playwright before opening a PR",
    type: "pattern",
    detail:
      "The product requires a browser check before UI changes are proposed.",
    source: "CONTRIBUTING.md",
  },
  {
    id: "anunay",
    title: "Anunay",
    type: "person",
    detail:
      "The graph separates personal preferences from project-specific instructions.",
  },
  {
    id: "concise-slack",
    title: "Prefer concise Slack messages",
    type: "pattern",
    detail:
      "A global writing preference that should follow Anunay across projects.",
    source: "user-preferences.md",
  },
  {
    id: "no-auto-push",
    title: "Never auto-push",
    type: "pattern",
    detail:
      "Changes can be prepared, but publishing requires explicit approval.",
    source: "AGENTS.md",
  },
  {
    id: "heroku",
    title: "Hosted on Heroku",
    type: "decision",
    detail:
      "The old hosting decision was correct for two years before the migration.",
    source: "adr-004.md",
    retiredBy: "Moved to Vercel",
  },
  {
    id: "vercel",
    title: "Moved to Vercel",
    type: "decision",
    detail:
      "The current deployment platform with preview environments for every pull request.",
    source: "vercel.json",
  },
  {
    id: "agent-failure",
    title: "Agent repeats the same tool mistake",
    type: "claim",
    detail:
      "Several sessions failed when the agent called the deployment tool before validating the schema.",
    source: "agent-runs-2026-05.jsonl",
  },
  {
    id: "routing-rule",
    title: "Validate before deploying",
    type: "decision",
    detail:
      "A learned workflow rule that prevents the repeated deployment failure.",
    source: "agent-improvements.md",
  },
  {
    id: "tool-order",
    title: "Tool ordering pattern",
    type: "pattern",
    detail:
      "Validate input, inspect dependencies, then call the deployment tool.",
    source: "agent-improvements.md",
  },
  {
    id: "launch-plan",
    title: "launch-plan.md",
    type: "entity",
    detail:
      "Current source for the launch date, owners, and remaining work.",
  },
  {
    id: "research",
    title: "customer-research.md",
    type: "entity",
    detail:
      "Evidence from customer interviews that changed the launch plan.",
  },
  {
    id: "contributing",
    title: "CONTRIBUTING.md",
    type: "entity",
    detail:
      "Source for repository conventions shared by every coding agent.",
  },
  {
    id: "agents-md",
    title: "AGENTS.md",
    type: "entity",
    detail:
      "Source for project rules and approval boundaries.",
  },
  {
    id: "incident",
    title: "incident-2026-04-17.md",
    type: "entity",
    detail:
      "Incident report explaining the Stripe webhook failure.",
  },
  {
    id: "agent-runs",
    title: "agent-runs-2026-05.jsonl",
    type: "entity",
    detail:
      "Run history showing the tool-ordering mistake recurring across sessions.",
  },
  {
    id: "scratch-note",
    title: "'Try restarting the server' — scratch",
    type: "claim",
    detail:
      "A session's first guess, wrong twice. Pruned on the record once the real fix landed — the removal is itself a memory.",
    source: "session-12.md",
  },
];

export const LINKS: {
  source: string;
  target: string;
  predicate: string;
}[] = [
  {
    source: "launch-date-current",
    target: "acme",
    predicate: "decides",
  },
  {
    source: "launch-date-old",
    target: "launch-date-current",
    predicate: "superseded by",
  },
  {
    source: "onboarding-friction",
    target: "launch-date-current",
    predicate: "caused",
  },
  {
    source: "research",
    target: "onboarding-friction",
    predicate: "evidence for",
  },
  {
    source: "pricing-update",
    target: "acme",
    predicate: "relates to",
  },
  {
    source: "priya",
    target: "acme",
    predicate: "owns",
  },
  {
    source: "priya",
    target: "launch-date-current",
    predicate: "approved",
  },
  {
    source: "launch-plan",
    target: "launch-date-current",
    predicate: "evidence for",
  },
  {
    source: "previous-agent",
    target: "stripe-migration",
    predicate: "worked on",
  },
  {
    source: "current-agent",
    target: "stripe-migration",
    predicate: "continues",
  },
  {
    source: "duplicate-event",
    target: "stripe-migration",
    predicate: "blocks",
  },
  {
    source: "incident",
    target: "duplicate-event",
    predicate: "evidence for",
  },
  {
    source: "webhook-fix",
    target: "duplicate-event",
    predicate: "fixes",
  },
  {
    source: "staging",
    target: "webhook-fix",
    predicate: "verifies",
  },
  {
    source: "repo-rules",
    target: "acme",
    predicate: "governs",
  },
  {
    source: "contributing",
    target: "pnpm",
    predicate: "evidence for",
  },
  {
    source: "agents-md",
    target: "no-legacy",
    predicate: "evidence for",
  },
  {
    source: "contributing",
    target: "playwright",
    predicate: "evidence for",
  },
  {
    source: "anunay",
    target: "concise-slack",
    predicate: "prefers",
  },
  {
    source: "anunay",
    target: "no-auto-push",
    predicate: "requires",
  },
  {
    source: "heroku",
    target: "vercel",
    predicate: "superseded by",
  },
  {
    source: "vercel",
    target: "acme",
    predicate: "hosts",
  },
  {
    source: "agent-failure",
    target: "acme",
    predicate: "relates to",
  },
  {
    source: "agent-runs",
    target: "agent-failure",
    predicate: "evidence for",
  },
  {
    source: "routing-rule",
    target: "agent-failure",
    predicate: "prevents",
  },
  {
    source: "tool-order",
    target: "routing-rule",
    predicate: "explains",
  },
  {
    source: "agent-runs",
    target: "tool-order",
    predicate: "evidence for",
  },
  {
    source: "scratch-note",
    target: "stripe-migration",
    predicate: "relates to",
  },
  {
    source: "stripe-migration",
    target: "acme",
    predicate: "part of",
  },
  {
    source: "previous-agent",
    target: "onboarding-friction",
    predicate: "investigated",
  },
  {
    source: "anunay",
    target: "repo-rules",
    predicate: "maintains",
  },
];

export const degreeOf = (id: string) =>
  LINKS.filter((l) => l.source === id || l.target === id).length;

export const seedById = new Map(SEEDS.map((s) => [s.id, s]));
