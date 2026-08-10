/**
 * Task-shaped scenarios. Each scenario is a fixed ordered sequence of sessions
 * that share one memory across the run. Session kinds:
 *   seed         — the agent is told a durable fact and asked to record it. Not
 *                  scored; it plants the state later sessions depend on.
 *   supersede    — a belief-change event; the agent is told a fact CHANGED and
 *                  asked to update records. Not scored directly; its effect is
 *                  read out by the following fresh-belief session.
 *   recall       — context-pickup: the answer must contain the planted fact.
 *   fresh-belief — supersession test: the answer must use the NEW value and
 *                  must NOT use the OLD (superseded) value.
 *   cite         — auditability: the answer must name the source/decision.
 *   control      — answerable from the task text alone (no memory). All arms
 *                  should tie; a trove "win" here means the harness is rigged.
 */

export type ScoreKind = "seed" | "supersede" | "recall" | "fresh-belief" | "cite" | "control";

export type Session = {
  n: number;
  task: string;
  seeds?: string[];
  supersedes?: { fact: string; old: string; new: string };
  score: {
    kind: ScoreKind;
    /** Substring(s) the answer must contain. An array means ANY match passes. */
    expect?: string | string[];
    /** Substring(s) the answer must NOT contain. An array means ANY present fails. */
    must_not?: string | string[];
  };
};

export type Scenario = {
  id: number;
  title: string;
  sessions: Session[];
};

export const scenarios: Scenario[] = [
  {
    id: 1,
    title: "Billing policy over 6 sessions",
    sessions: [
      {
        n: 1,
        task: "Record our refund rule for annual plans: annual plans are non-refundable after 14 days.",
        seeds: ["Annual plans are non-refundable after 14 days."],
        score: { kind: "seed" },
      },
      {
        n: 2,
        task: "Record who owns churn emails: Customer Success owns churn emails.",
        seeds: ["Customer Success owns churn emails."],
        score: { kind: "seed" },
      },
      {
        n: 3,
        task: "A customer on an annual plan asks for a refund on day 10. What is our refund policy for annual plans?",
        score: { kind: "recall", expect: "14" },
      },
      {
        n: 4,
        task: "Policy change: annual plans are now refundable within 30 days. Update our records so this replaces the old rule.",
        seeds: ["Annual plans are refundable within 30 days."],
        supersedes: { fact: "annual refund policy", old: "14 days non-refundable", new: "refundable within 30 days" },
        score: { kind: "supersede" },
      },
      {
        n: 5,
        task: "A customer on an annual plan wants a refund on day 20. What is our current refund policy for annual plans?",
        score: { kind: "fresh-belief", expect: "30", must_not: "14" },
      },
      {
        n: 6,
        task: "Where did our current annual-plan refund policy come from? Reference the recorded change.",
        score: { kind: "cite", expect: ["policy change", "supersede", "replace", "recorded change", "previous policy", "outdated"] },
      },
      {
        n: 7,
        task: "A customer writes: 'I'm on the monthly plan and want to cancel today.' Which plan is this customer on?",
        score: { kind: "control", expect: "monthly" },
      },
    ],
  },
  {
    id: 2,
    title: "Oncall runbook that gets corrected",
    sessions: [
      {
        n: 1,
        task: "Record an ops fact: the web service listens on port 8787.",
        seeds: ["The web service listens on port 8787."],
        score: { kind: "seed" },
      },
      {
        n: 2,
        task: "Record an ops fact: PagerDuty escalation for the web service goes to the Platform team.",
        seeds: ["PagerDuty escalation for the web service goes to the Platform team."],
        score: { kind: "seed" },
      },
      {
        n: 3,
        task: "The web service looks unreachable. Which port should I check that the web service is listening on?",
        score: { kind: "recall", expect: "8787" },
      },
      {
        n: 4,
        task: "Correction: the web service was moved to port 9090. Update our records so this replaces the old port.",
        seeds: ["The web service was moved to port 9090."],
        supersedes: { fact: "web service port", old: "8787", new: "9090" },
        score: { kind: "supersede" },
      },
      {
        n: 5,
        task: "A health check is failing. Which port does the web service listen on now?",
        score: { kind: "fresh-belief", expect: "9090", must_not: "8787" },
      },
      {
        n: 6,
        task: "Why did the web service port change, and where is that recorded?",
        score: { kind: "cite", expect: ["moved", "correction", "supersede", "replace", "changed", "previous port"] },
      },
      {
        n: 7,
        task: "An alert fires at 3am: \"service 'db' is down\". Which service fired this alert?",
        score: { kind: "control", expect: "db" },
      },
    ],
  },
  {
    id: 3,
    title: "API contract decision that changes",
    sessions: [
      {
        n: 1,
        task: "Record an API contract fact: our public API returns timestamps as Unix epoch seconds.",
        seeds: ["Our public API returns timestamps as Unix epoch seconds."],
        score: { kind: "seed" },
      },
      {
        n: 2,
        task: "Record an API contract fact: the API version is sent in the 'X-API-Version' header.",
        seeds: ["The API version is sent in the 'X-API-Version' header."],
        score: { kind: "seed" },
      },
      {
        n: 3,
        task: "A client asks what format our API returns timestamps in. What do we tell them?",
        score: { kind: "recall", expect: "epoch" },
      },
      {
        n: 4,
        task: "Decision: we now return timestamps as ISO 8601 strings, not epoch seconds. Update our records so this replaces the old format.",
        seeds: ["The public API returns timestamps as ISO 8601 strings."],
        supersedes: { fact: "API timestamp format", old: "epoch seconds", new: "ISO 8601 strings" },
        score: { kind: "supersede" },
      },
      {
        n: 5,
        task: "A new client integration asks about our timestamp format. What is the current API contract for timestamps?",
        score: { kind: "fresh-belief", expect: "ISO 8601", must_not: "epoch" },
      },
      {
        n: 6,
        task: "Where did our current timestamp-format contract come from? Reference the recorded decision.",
        score: { kind: "cite", expect: ["decision", "supersede", "replace", "changed", "previously", "recorded"] },
      },
      {
        n: 7,
        task: "A client request carries the header 'X-Request-Id: abc123'. What is this request's id?",
        score: { kind: "control", expect: "abc123" },
      },
    ],
  },
  {
    id: 4,
    title: "Project ownership that changes in a reorg",
    sessions: [
      {
        n: 1,
        task: "Record an ownership fact: the billing service is owned by the Payments team.",
        seeds: ["The billing service is owned by the Payments team."],
        score: { kind: "seed" },
      },
      {
        n: 2,
        task: "Record an ownership fact: the billing service lives in the 'trove-billing' repo.",
        seeds: ["The billing service lives in the 'trove-billing' repo."],
        score: { kind: "seed" },
      },
      {
        n: 3,
        task: "I need to file a bug against the billing service. Which team owns the billing service?",
        score: { kind: "recall", expect: "Payments" },
      },
      {
        n: 4,
        task: "Reorg: the billing service is now owned by the Growth team. Update our records so this replaces the old owner.",
        seeds: ["The billing service is now owned by the Growth team."],
        supersedes: { fact: "billing service owner", old: "Payments team", new: "Growth team" },
        score: { kind: "supersede" },
      },
      {
        n: 5,
        task: "I need a code review on the billing service. Which team owns it now and should I ask?",
        score: { kind: "fresh-belief", expect: "Growth", must_not: "Payments" },
      },
      {
        n: 6,
        task: "Why is the current team the owner of the billing service? Reference the recorded change.",
        score: { kind: "cite", expect: ["reorg", "supersede", "replace", "changed", "previous owner", "recorded change"] },
      },
      {
        n: 7,
        task: "A ticket reads: 'billing service returns HTTP 500 on /invoices'. Which endpoint is failing?",
        score: { kind: "control", expect: "/invoices" },
      },
    ],
  },
];

export function scenarioById(id: number): Scenario {
  const s = scenarios.find((sc) => sc.id === id);
  if (!s) throw new Error(`No scenario ${id}`);
  return s;
}
