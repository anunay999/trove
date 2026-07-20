/**
 * The Trove thesis dataset.
 *
 * Trove is more complex than a vector store: it distills sources into atoms,
 * links them, and traverses those links at recall time. That complexity is only
 * worth its cost if it answers questions flat retrieval *structurally cannot*.
 * This dataset is built to isolate exactly that.
 *
 * THE DESIGN CONSTRAINT — every multi-hop item's answer requires composing two
 * or more facts that share no text unit, AND the entity joining them never
 * appears in the question. That second half is what makes the test honest: if
 * the question says "Obsidian", embedding similarity retrieves both spans and
 * the graph is decoration. With the join term absent, flat retrieval has to get
 * lucky twice while traversal follows an edge. `bridgeTerms` records those
 * terms and the runner ASSERTS they are absent from the question, so the
 * property is enforced mechanically rather than by the author's care.
 *
 * THE CONTROLS matter as much as the multi-hop items. A win on multi-hop alone
 * is ambiguous — maybe this corpus just suits Trove. Single-hop controls are
 * directly answerable from one span, so flat retrieval should tie or win. The
 * result that supports the thesis is a SPLIT: Trove ahead on bridge/chain,
 * level on control. Trove winning everything means the dataset is rigged and
 * should be rebuilt.
 *
 * All sessions from all items are ingested into ONE corpus, so every item's
 * spans act as distractors for every other item. Per-item isolation would make
 * retrieval trivial for both systems and measure nothing.
 */

export type ThesisShape = "bridge" | "chain" | "supersede" | "control";

export type ThesisItem = {
  id: string;
  shape: ThesisShape;
  /** Ingested verbatim as separate sources — the runner never concatenates them. */
  sessions: string[];
  question: string;
  /** Accepted answer forms, lowercased substring match against the model's reply. */
  answers: string[];
  /**
   * The join entities. Asserted ABSENT from the question — this is the property
   * that makes the item a genuine graph test rather than a similarity test.
   * Empty for controls, which have nothing to join.
   */
  bridgeTerms: string[];
  /**
   * Distinctive strings from each fact the answer must compose. The runner
   * reports "bridge coverage": did retrieval surface every hop? This separates
   * a retrieval failure from an answering failure — without it, a wrong answer
   * is uninterpretable.
   */
  requiredFacts: string[];
};

export const THESIS_ITEMS: ThesisItem[] = [
  // ---- bridge: two hops, join entity absent from the question ---------------
  {
    id: "bridge-notes-sync",
    shape: "bridge",
    sessions: [
      "Spent the morning migrating my personal notes off Notion. Everything lives in Obsidian now — much faster and the files are just markdown on disk.",
      "Finally sorted the sync situation. The Obsidian vault replicates to the desktop upstairs over Syncthing, so both machines stay current without a cloud account.",
    ],
    question: "How do my notes end up on my desktop machine?",
    answers: ["syncthing"],
    bridgeTerms: ["obsidian"],
    requiredFacts: ["notes off Notion", "Syncthing"],
  },
  {
    id: "bridge-invoice-owner",
    shape: "bridge",
    sessions: [
      "Priya took over the billing service in March after Marcus moved to infrastructure. She's the one to loop in on anything that touches it.",
      "Reminder from the architecture review: the billing service owns invoice retry logic, including the backoff schedule and the dead-letter queue.",
    ],
    question: "Who should I ask about invoice retries?",
    answers: ["priya"],
    bridgeTerms: ["billing service", "billing"],
    requiredFacts: ["Priya took over", "invoice retry"],
  },
  {
    id: "bridge-backup-retention",
    shape: "bridge",
    sessions: [
      "Staging finally moved off the shared box. The staging database now runs in eu-west-2 alongside the analytics replicas.",
      "Compliance signed off on the regional policies: eu-west-2 keeps thirty days of backup retention, us-east-1 keeps seven.",
    ],
    question: "How long are staging database backups kept?",
    answers: ["thirty days", "30 days", "thirty"],
    bridgeTerms: ["eu-west-2"],
    requiredFacts: ["staging database now runs", "thirty days of backup retention"],
  },
  {
    id: "bridge-grocery-rewards",
    shape: "bridge",
    sessions: [
      "Switched my everyday spending card over to the Amex this month — the annual fee finally makes sense given how much goes on it.",
      "Checked the rewards table again: the Amex earns 4% back on groceries and 1% on everything else. The Visa is a flat 2%.",
    ],
    question: "What do I earn back on grocery shopping now?",
    answers: ["4%", "4 percent", "four percent"],
    bridgeTerms: ["amex"],
    requiredFacts: ["everyday spending card", "4% back on groceries"],
  },
  {
    id: "bridge-standup-timezone",
    shape: "bridge",
    sessions: [
      "The mobile team relocated to the Helsinki office in the reshuffle — all six of them, plus the two new hires starting next month.",
      "Scheduling note for anyone booking cross-office meetings: the Helsinki office runs on CET, Bangalore on IST, and Austin on CDT.",
    ],
    question: "What timezone should I use when booking the mobile team's standup?",
    answers: ["cet"],
    bridgeTerms: ["helsinki"],
    requiredFacts: ["mobile team relocated", "Helsinki office runs on CET"],
  },

  // ---- chain: three hops -----------------------------------------------------
  {
    id: "chain-auth-escalation",
    shape: "chain",
    sessions: [
      "Ownership is settled: the authentication service is maintained by the platform team going forward, not by security.",
      "The platform team runs a weekly on-call rotation. Handover happens Monday mornings at the team sync.",
      "All on-call escalations route through the PagerDuty channel #plat-oncall. Don't DM individuals — it breaks the audit trail.",
    ],
    question: "Where do I escalate an authentication outage at 2am?",
    answers: ["#plat-oncall", "plat-oncall"],
    bridgeTerms: ["platform team", "on-call", "oncall"],
    requiredFacts: ["authentication service is maintained", "weekly on-call rotation", "#plat-oncall"],
  },
  {
    id: "chain-bike-tyres",
    shape: "chain",
    sessions: [
      "The road bike is the Canyon — the aluminium one, not the carbon frame I keep talking myself out of buying.",
      "Worth noting for next time: the Canyon takes 700x28 tyres. The 25s I tried were too narrow for the rims.",
      "Reorganised the garage. Spare 700x28 tyres are in the blue bin on the top shelf, tubes in the red one below it.",
    ],
    question: "Where are the spare tyres for my road bike?",
    answers: ["blue bin"],
    bridgeTerms: ["canyon", "700x28"],
    requiredFacts: ["road bike is the Canyon", "takes 700x28", "blue bin"],
  },

  // ---- supersede: the graph must prefer the newer belief AND hop -------------
  {
    id: "supersede-deploy-freeze",
    shape: "supersede",
    sessions: [
      "Policy reminder: deploys are frozen on Fridays. Nothing ships into the weekend without an incident commander signing off.",
      "The deploy freeze applies to the payments repo and the ledger service. Everything else follows the normal release train.",
      "Update from the ops review — the deploy freeze moved off Friday. It now falls on Thursday, to give support a clear day before the weekend.",
    ],
    question: "Which day can't I ship the payments repo?",
    answers: ["thursday"],
    bridgeTerms: ["deploy freeze", "freeze"],
    requiredFacts: ["applies to the payments repo", "now falls on Thursday"],
  },
  {
    id: "supersede-standup-time",
    shape: "supersede",
    sessions: [
      "Standup is at 9:00am sharp. Camera on for the first five minutes, then it's optional.",
      "Rota update: the design lead runs standup for the rest of the quarter while the EM is on sabbatical.",
      "Heads up, standup shifted to 9:30am starting next week — the earlier slot clashed with the Helsinki office's commute.",
    ],
    question: "What time does the design lead run the daily sync?",
    answers: ["9:30", "9.30", "half nine", "nine thirty"],
    bridgeTerms: ["standup"],
    requiredFacts: ["design lead runs standup", "shifted to 9:30am"],
  },

  // ---- control: single hop; flat retrieval should tie or win -----------------
  {
    id: "control-wifi",
    shape: "control",
    sessions: ["The guest wifi password for the office is trove-guest-2026. It rotates at the end of every quarter."],
    question: "What is the office guest wifi password?",
    answers: ["trove-guest-2026"],
    bridgeTerms: [],
    requiredFacts: ["trove-guest-2026"],
  },
  {
    id: "control-billing-cadence",
    shape: "control",
    sessions: ["We bill monthly, not annually. Annual contracts exist but they're invoiced in twelve monthly instalments."],
    question: "What is our billing cadence?",
    answers: ["monthly"],
    bridgeTerms: [],
    requiredFacts: ["bill monthly"],
  },
  {
    id: "control-rate-limit",
    shape: "control",
    sessions: ["The public API rate limit is 1000 requests per minute per key. Burst allowance is 50 on top of that."],
    question: "What is the public API rate limit?",
    answers: ["1000 requests per minute", "1000 per minute", "1000"],
    bridgeTerms: [],
    requiredFacts: ["1000 requests per minute"],
  },
  {
    id: "control-retro-schedule",
    shape: "control",
    sessions: ["Retros happen on the last Thursday of the month, 3pm, and we rotate who facilitates."],
    question: "When do retros happen?",
    answers: ["last thursday"],
    bridgeTerms: [],
    requiredFacts: ["last Thursday of the month"],
  },
  {
    id: "control-postgres-version",
    shape: "control",
    sessions: ["Production runs Postgres 16. Staging is still on 15 until the extension audit finishes."],
    question: "What Postgres version does production run?",
    answers: ["16", "postgres 16"],
    bridgeTerms: [],
    requiredFacts: ["Production runs Postgres 16"],
  },
  {
    id: "control-cs-lead",
    shape: "control",
    sessions: ["Sam is the customer success lead and owns the churn escalation path end to end."],
    question: "Who is the customer success lead?",
    answers: ["sam"],
    bridgeTerms: [],
    requiredFacts: ["Sam is the customer success lead"],
  },
];

/**
 * Enforce the property the dataset's validity rests on: a multi-hop question
 * must never name the entity that joins its hops. Called by the runner BEFORE
 * anything is ingested — a violated item would silently degrade into a
 * similarity test and quietly inflate the flat baseline's score.
 */
export function validateDataset(items: ThesisItem[] = THESIS_ITEMS): string[] {
  const problems: string[] = [];
  for (const item of items) {
    const question = item.question.toLowerCase();
    for (const term of item.bridgeTerms) {
      if (question.includes(term.toLowerCase())) {
        problems.push(`${item.id}: question names its bridge term "${term}" — not a graph test`);
      }
    }
    if (item.shape !== "control" && item.bridgeTerms.length === 0) {
      problems.push(`${item.id}: multi-hop item declares no bridge terms`);
    }
    if (item.shape !== "control" && item.requiredFacts.length < 2) {
      problems.push(`${item.id}: multi-hop item needs a requiredFact per hop`);
    }
    if (item.shape === "control" && item.sessions.length !== 1) {
      problems.push(`${item.id}: a control must be answerable from ONE span`);
    }
  }
  return problems;
}
