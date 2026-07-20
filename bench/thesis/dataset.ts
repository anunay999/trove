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

  {
    id: "bridge-gym-locker",
    shape: "bridge",
    sessions: [
      "Joined the new gym on the corner, Iron Works — membership sorted under Whitfield, number IW-4471, induction done.",
      "Iron Works assigns lockers by surname: A-M on the ground floor, N-Z up on the mezzanine.",
    ],
    question: "Which floor is my gym locker on?",
    answers: ["mezzanine"],
    bridgeTerms: ["iron works"],
    requiredFacts: ["membership sorted under Whitfield", "N-Z up on the mezzanine"],
  },
  {
    id: "bridge-lunch-vegan-count",
    shape: "bridge",
    sessions: [
      "Mei from the data team asked me to handle Friday's team lunch booking this week — she's travelling on the day.",
      "Dietary counts for the offsite planning doc: the data team is 3 omnivores, 2 vegetarians and 1 vegan; the platform team is 5 omnivores and 2 vegans.",
    ],
    question: "How many vegan meals should Friday's lunch booking cover?",
    answers: ["1", "one"],
    bridgeTerms: ["data team"],
    requiredFacts: ["handle Friday's team lunch booking", "data team is 3 omnivores"],
  },
  {
    id: "bridge-demo-connector",
    shape: "bridge",
    sessions: [
      "Booked the boardroom for Thursday's client demo — the big room on the third floor, since the usual one only seats six.",
      "Facilities note: the boardroom projector only takes HDMI — the DisplayPort adapter was retired last month. The smaller meeting rooms all take USB-C.",
    ],
    question: "What connector do I need for Thursday's client demo?",
    answers: ["hdmi"],
    bridgeTerms: ["boardroom"],
    requiredFacts: ["client demo", "only takes HDMI"],
  },
  {
    id: "bridge-insurance-claim-line",
    shape: "bridge",
    sessions: [
      "My car insurance moved to Vantage Mutual this year — the old provider doubled the premium at renewal.",
      "Filed the insurance cards: Vantage Mutual's emergency claims line is 0800-555-0147; Northgate Insurance's is 0800-555-0132.",
    ],
    question: "What number do I call for a car insurance claim?",
    answers: ["0800-555-0147", "0147"],
    bridgeTerms: ["vantage"],
    requiredFacts: ["car insurance moved to Vantage Mutual", "0800-555-0147"],
  },
  {
    id: "bridge-vet-booking-window",
    shape: "bridge",
    sessions: [
      "Biscuit the cat is now registered with Dr. Okafor at the Riverside clinic — she handled the ear infection brilliantly.",
      "Scheduling quirks at the local clinics: Riverside sees cats on weekday mornings only; the Oakhill branch takes cats all day Tuesday and Thursday.",
    ],
    question: "When can I book Biscuit's check-ups?",
    answers: ["weekday mornings", "weekday morning", "mornings"],
    bridgeTerms: ["riverside"],
    requiredFacts: ["registered with Dr. Okafor", "weekday mornings only"],
  },
  {
    id: "bridge-library-holds-hours",
    shape: "bridge",
    sessions: [
      "All my library holds now go to the Central Library branch — it's on the way home from the office.",
      "Winter opening hours: Central Library closes at 6pm on weekdays and 2pm on Saturdays; the Westside branch stays open till 9pm.",
    ],
    question: "What time do I need to collect my holds by on a Wednesday?",
    answers: ["6pm", "6 pm", "18:00"],
    bridgeTerms: ["central library"],
    requiredFacts: ["holds now go to the Central Library", "closes at 6pm"],
  },
  {
    id: "bridge-ski-pass-collection",
    shape: "bridge",
    sessions: [
      "Bought the season pass for Valemount this year — first time skiing there; the reviews of the north bowl sold me.",
      "Lift-pass logistics: at Valemount, season-pass cards are collected at the east ticket office; at Pinewood they're posted out in November.",
    ],
    question: "Where do I pick up my ski pass card?",
    answers: ["east ticket office"],
    bridgeTerms: ["valemount"],
    requiredFacts: ["season pass for Valemount", "east ticket office"],
  },
  {
    id: "bridge-badge-pickup",
    shape: "bridge",
    sessions: [
      "Our team's desks moved to the Atlas building on Monday — floor 4, by the big staircase.",
      "Security note: Atlas building badges are issued at the basement security desk; Beacon tower badges at reception. Temporary badges expire at midnight.",
    ],
    question: "Where do I collect my new office badge?",
    answers: ["basement security desk", "basement"],
    bridgeTerms: ["atlas"],
    requiredFacts: ["desks moved to the Atlas building", "basement security desk"],
  },
  {
    id: "bridge-coffee-grind",
    shape: "bridge",
    sessions: [
      "My coffee subscription switched to the Guatemalan single origin this month — the Brazilian was getting boring.",
      "Roaster notes: the Guatemalan single origin ships whole-bean only; the Brazilian and the house blend can be ground on request.",
    ],
    question: "Does my subscription coffee arrive ground or as beans?",
    answers: ["whole-bean", "whole bean", "beans"],
    bridgeTerms: ["guatemalan"],
    requiredFacts: ["subscription switched to the Guatemalan", "whole-bean only"],
  },
  {
    id: "bridge-alert-channel-sla",
    shape: "bridge",
    sessions: [
      "Ownership shuffle: the inventory service now belongs to Felix's team — they took it over in the Q3 reshuffle.",
      "Felix's team monitors all its services through #alerts-west with a 15-minute response SLA; #alerts-east, the old team's channel, is best-effort now.",
    ],
    question: "Which channel gets the fastest response for inventory service alerts?",
    answers: ["#alerts-west", "alerts-west"],
    bridgeTerms: ["felix"],
    requiredFacts: ["inventory service now belongs to Felix's team", "#alerts-west"],
  },
  {
    id: "bridge-piano-room-temp",
    shape: "bridge",
    sessions: [
      "The upright piano finally arrived — a Kawai K-300, second-hand but beautifully kept.",
      "Dealer's care notes: the Kawai K-300 holds its tuning best at 20-22°C; the old Clavinova in the studio is fine down to 15°C.",
    ],
    question: "What temperature should I keep the piano room at?",
    answers: ["20-22", "20–22", "20 to 22"],
    bridgeTerms: ["kawai", "k-300"],
    requiredFacts: ["Kawai K-300", "20-22"],
  },
  {
    id: "bridge-food-scrap-bin",
    shape: "bridge",
    sessions: [
      "Our street got moved into the green waste pilot zone this month — the council letter arrived Tuesday.",
      "Green waste pilot rules: food-scrap bins go out Sunday evening for a 6am Monday collection. Streets outside the pilot put food scraps in the regular Thursday rubbish.",
    ],
    question: "When should our food scraps bin go out?",
    answers: ["sunday evening", "sunday"],
    bridgeTerms: ["green waste pilot", "pilot"],
    requiredFacts: ["moved into the green waste pilot zone", "Sunday evening"],
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

  {
    id: "chain-prescription-pharmacy",
    shape: "chain",
    sessions: [
      "Dr. Hana put me on loratadine for the allergies as of today — the old antihistamine made me drowsy.",
      "Insurance quirk: loratadine is only covered when it's filled at a CarePlus partner pharmacy — anywhere else is full price.",
      "Looked up the CarePlus partners: the nearest one is the pharmacy inside the Harborview supermarket on 5th Street.",
    ],
    question: "Where should I get my new allergy prescription filled?",
    answers: ["harborview", "5th street"],
    bridgeTerms: ["loratadine", "careplus"],
    requiredFacts: ["put me on loratadine", "CarePlus partner pharmacy", "Harborview supermarket"],
  },
  {
    id: "chain-golive-approval",
    shape: "chain",
    sessions: [
      "The checkout rewrite is shipping under the Phoenix release train — marketing wants the announcement timed with it.",
      "Phoenix train releases need sign-off from the release board before anything reaches production.",
      "The release board meets Tuesdays at 2pm in the Horizon room; agenda items go in the #release-board thread by Monday noon.",
    ],
    question: "Where do I put the checkout rewrite's go-live up for approval?",
    answers: ["#release-board", "release-board"],
    bridgeTerms: ["phoenix", "release board"],
    requiredFacts: ["Phoenix release train", "sign-off from the release board", "#release-board thread"],
  },
  {
    id: "chain-allotment-tomatoes",
    shape: "chain",
    sessions: [
      "This year's allotment plot is number 14 — the one by the shed, which the association finally cleared of brambles.",
      "Plot 14 has a history of blight in wet summers, so the association recommends blight-resistant varieties for it.",
      "Of the blight-resistant varieties, Crimson Crush does best in our soil — Mountain Magic split badly last year.",
    ],
    question: "Which tomatoes should I grow on my allotment this year?",
    answers: ["crimson crush"],
    bridgeTerms: ["plot 14", "resistant"],
    requiredFacts: ["plot is number 14", "history of blight", "Crimson Crush"],
  },
  {
    id: "chain-washer-repair-booking",
    shape: "chain",
    sessions: [
      "The new washing machine is the Bosch Series 6 — bought in the January sale, delivery next Tuesday.",
      "Warranty note: Bosch Series 6 repairs go through ApplianceCare, Bosch's contracted service partner, not the retailer.",
      "ApplianceCare books all jobs through their online portal; they no longer take phone bookings.",
    ],
    question: "How do I book a repair if the washing machine breaks down?",
    answers: ["online portal", "portal"],
    bridgeTerms: ["bosch", "appliancecare"],
    requiredFacts: ["Bosch Series 6", "ApplianceCare", "online portal"],
  },
  {
    id: "chain-conference-journey",
    shape: "chain",
    sessions: [
      "I'm presenting the roadmap talk at DevConf this year — the acceptance email came through this morning.",
      "DevConf moved from Berlin to Porto this year — the original venue fell through in January.",
      "For Porto, company travel policy says fly into Lisbon and take the train up — direct flights price out above the cap.",
    ],
    question: "How am I meant to travel to the conference?",
    answers: ["lisbon", "train"],
    bridgeTerms: ["devconf", "porto"],
    requiredFacts: ["roadmap talk at DevConf", "moved from Berlin to Porto", "fly into Lisbon"],
  },
  {
    id: "chain-puppy-class-kit",
    shape: "chain",
    sessions: [
      "Pepper starts puppy classes next month — the rescue says she's about four months old now.",
      "The certified trainer the rescue approved for us is Marta at Happy Hounds — she runs the Tuesday evening sessions.",
      "Marta asks owners to bring a long training lead and no treats — she supplies reward treats herself. Pete, the weekend trainer, does it the other way: treats welcome, short lead.",
    ],
    question: "What should I take to Pepper's first class?",
    answers: ["long training lead", "training lead", "long lead"],
    bridgeTerms: ["puppy classes", "marta", "happy hounds"],
    requiredFacts: ["starts puppy classes", "Marta at Happy Hounds", "long training lead"],
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

  {
    id: "supersede-parking-permit",
    shape: "supersede",
    sessions: [
      "My parking permit for the office car park is P-8814, valid from April.",
      "The office car park requires the permit displayed on the dashboard — enforcement started last month and they do clamp.",
      "New permit arrived after the plate change: P-9032. The old one is cancelled, so bin it.",
    ],
    question: "Which permit number should be on my dashboard at the office?",
    answers: ["p-9032", "9032"],
    bridgeTerms: ["office car park", "parking permit"],
    requiredFacts: ["permit displayed on the dashboard", "P-9032"],
  },
  {
    id: "supersede-shed-bikes-policy",
    shape: "supersede",
    sessions: [
      "Home insurance renewed with Hartley & Co — policy number HC-2201, £412 for the year.",
      "The home insurance is what covers the bikes in the shed, as long as each one is under £1500.",
      "Switched the home insurance at renewal — it's Meridian Mutual now, policy MM-8810, £356 for the year. Cancelled the Hartley direct debit.",
    ],
    question: "Which policy number are the bikes in the shed covered under?",
    answers: ["mm-8810", "8810"],
    bridgeTerms: ["home insurance"],
    requiredFacts: ["covers the bikes in the shed", "MM-8810"],
  },
  {
    id: "supersede-hotel-cap",
    shape: "supersede",
    sessions: [
      "Company travel policy caps London hotels at £150 a night. Anything above needs VP sign-off.",
      "The June offsite is booked under the company travel policy — finance confirmed it applies even though it's technically 'team building'.",
      "Policy update from finance: the London hotel cap moved to £190 a night — the old figure predates the rate increases.",
    ],
    question: "What's the most we can pay per night for the offsite hotel?",
    answers: ["190", "£190"],
    bridgeTerms: ["travel policy", "policy"],
    requiredFacts: ["offsite is booked under the company travel policy", "cap moved to £190"],
  },
  {
    id: "supersede-biscuit-dose",
    shape: "supersede",
    sessions: [
      "Started Biscuit on 5mg of the anti-inflammatory once a day, per the vet's first prescription.",
      "The anti-inflammatory is the long-term plan for Biscuit's hip — bloodwork review every six months.",
      "Vet called after the bloodwork: drop Biscuit to 2.5mg a day — her kidney numbers want the lower dose.",
    ],
    question: "How much of her hip medicine should Biscuit get each day?",
    answers: ["2.5"],
    bridgeTerms: ["anti-inflammatory"],
    requiredFacts: ["long-term plan for Biscuit's hip", "2.5mg"],
  },
  {
    id: "supersede-release-rhythm",
    shape: "supersede",
    sessions: [
      "The mobile guild runs two-week sprints — planning every other Monday, demos on the closing Friday.",
      "The mobile guild's cadence sets the release rhythm for the app: releases go out at the end of every iteration.",
      "From next quarter the guild moves to one-week sprints — the two-week cadence was hiding scope creep, per the retro.",
    ],
    question: "How often do app releases go out now?",
    answers: ["every week", "weekly", "once a week", "each week"],
    bridgeTerms: ["sprint", "iteration"],
    requiredFacts: ["end of every iteration", "one-week sprints"],
  },
  {
    id: "supersede-adr-venue",
    shape: "supersede",
    sessions: [
      "The Thursday architecture sync lives in the Rocket room — booked for the whole quarter.",
      "The Thursday architecture sync is where ADRs get ratified; miss it and your ADR waits a week.",
      "Room shuffle: the Thursday architecture sync moves to the Nebula room from this week — Rocket is getting a refit.",
    ],
    question: "Where do I take my ADR on Thursday?",
    answers: ["nebula"],
    bridgeTerms: ["architecture sync"],
    requiredFacts: ["ADRs get ratified", "Nebula room"],
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
  {
    id: "control-passport-expiry",
    shape: "control",
    sessions: ["My passport expires in March 2027 — renewal appointments open six months before expiry."],
    question: "When does my passport expire?",
    answers: ["march 2027"],
    bridgeTerms: [],
    requiredFacts: ["expires in March 2027"],
  },
  {
    id: "control-aws-region",
    shape: "control",
    sessions: ["Our primary AWS region is eu-central-1; the DR region is eu-west-1."],
    question: "What is our primary AWS region?",
    answers: ["eu-central-1"],
    bridgeTerms: [],
    requiredFacts: ["eu-central-1"],
  },
  {
    id: "control-piano-exam",
    shape: "control",
    sessions: ["Elena passed her Grade 5 piano exam with distinction — the highest mark she's had so far."],
    question: "Which piano exam grade did Elena pass?",
    answers: ["grade 5", "grade five"],
    bridgeTerms: [],
    requiredFacts: ["Grade 5 piano exam"],
  },
  {
    id: "control-desk-height",
    shape: "control",
    sessions: ["The standing desk tops out at 128cm — plenty for my height, and the sitting preset is saved at 74cm."],
    question: "How high does the standing desk go?",
    answers: ["128"],
    bridgeTerms: [],
    requiredFacts: ["128cm"],
  },
  {
    id: "control-invoice-sequence",
    shape: "control",
    sessions: ["Customer invoice numbers start at INV-5000 this fiscal year — last year's sequence ended at INV-4999."],
    question: "What is the first customer invoice number this fiscal year?",
    answers: ["inv-5000"],
    bridgeTerms: [],
    requiredFacts: ["INV-5000"],
  },
  {
    id: "control-spin-class",
    shape: "control",
    sessions: ["The Saturday spin class starts at 8:15am this term — ten minutes earlier than before, so set the alarm accordingly."],
    question: "What time does the Saturday spin class start?",
    answers: ["8:15"],
    bridgeTerms: [],
    requiredFacts: ["8:15am"],
  },
  {
    id: "control-bastion-port",
    shape: "control",
    sessions: ["The bastion host listens on SSH port 2222, not 22 — the standard port is firewalled off."],
    question: "Which SSH port does the bastion host use?",
    answers: ["2222"],
    bridgeTerms: [],
    requiredFacts: ["SSH port 2222"],
  },
  {
    id: "control-sourdough-temp",
    shape: "control",
    sessions: ["Sourdough proofs best at 24°C in this kitchen — the oven with just the light on holds that almost exactly."],
    question: "What temperature should the sourdough proof at?",
    answers: ["24"],
    bridgeTerms: [],
    requiredFacts: ["24°C"],
  },
  {
    id: "control-mortgage-rate",
    shape: "control",
    sessions: ["The mortgage is fixed at 4.1% until October 2027 — then it reverts to the standard variable rate."],
    question: "What rate is the mortgage fixed at?",
    answers: ["4.1"],
    bridgeTerms: [],
    requiredFacts: ["fixed at 4.1%"],
  },
  {
    id: "control-review-sla",
    shape: "control",
    sessions: ["The code review SLA is one working day — anything older than that, ping the author directly."],
    question: "What is the code review SLA?",
    answers: ["one working day", "1 working day"],
    bridgeTerms: [],
    requiredFacts: ["one working day"],
  },
  {
    id: "control-marathon-date",
    shape: "control",
    sessions: ["The Manchester marathon is on April 19th this year — the training plan starts January 5th."],
    question: "When is the Manchester marathon?",
    answers: ["april 19", "19 april", "april 19th"],
    bridgeTerms: [],
    requiredFacts: ["April 19th"],
  },
  {
    id: "control-vat-number",
    shape: "control",
    sessions: ["Our VAT registration number is GB 884 2103 55 — it goes on every customer invoice footer."],
    question: "What is our VAT registration number?",
    answers: ["gb 884 2103 55", "884 2103 55"],
    bridgeTerms: [],
    requiredFacts: ["GB 884 2103 55"],
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
