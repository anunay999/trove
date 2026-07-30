/**
 * Generate the thesis harness's distractor corpus (backlog #31).
 *
 * The n=51 run ingested 100 text units and TOP_K=8 retrieved 8% of everything
 * per question — retrieval was barely a filter, and the resulting number had to
 * be retracted. This script generates the haystack that makes retrieval real:
 * ~5,500 short, single-line, single-fact notes (one text unit each by
 * construction), written into bench/thesis/distractors.json for run.ts to
 * ingest. Committing the generated corpus keeps the haystack identical across
 * runs — a regenerated haystack makes two runs incomparable.
 *
 * Safety properties, enforced MECHANICALLY (an answer-bearing distractor would
 * silently rig the instrument):
 *
 * - Banned strings: every item's answers[] (≥4 chars), bridgeTerms[] and
 *   requiredFacts[], plus a hand-listed set of item proper nouns. A note
 *   containing any of them (normalized containment) is dropped and counted.
 * - Domains are adjacent-but-different: same attribute TYPES as the items
 *   (meeting times, policy caps, permit numbers, pet doses) with different
 *   SUBJECTS, so the haystack is hard without being able to answer a question.
 * - Exact-duplicate notes are dropped (ingest dedupes identical sources, which
 *   would quietly shrink the haystack).
 *
 * Cost: ~count/25 chat calls to the distractor model (default gpt-4o-mini).
 *
 *   npx tsx bench/thesis/genDistractors.ts [count=5500]
 */

import { writeFile } from "node:fs/promises";
import { THESIS_ITEMS } from "./dataset.js";

const COUNT = Number(process.argv[2] ?? 5500);
const BATCH = 25;
const CONCURRENCY = 6;
const MODEL = process.env.TROVE_THESIS_DISTRACTOR_MODEL ?? "gpt-4o-mini";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OUT = new URL("./distractors.json", import.meta.url);

if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY required");

// Domains adjacent to the thesis items (same attribute types, DIFFERENT
// subjects) followed by plainly unrelated everyday domains. Each subject is a
// concrete, non-item thing the notes are about.
const DOMAINS: Array<{ domain: string; subjects: string[] }> = [
  // --- adjacent: meetings & work rituals (items: standup, retro, offsite) ----
  { domain: "team meetings", subjects: ["the marketing sync", "the 1:1 with the EM", "the design crit", "the sprint planning"] },
  { domain: "release process", subjects: ["the hotfix window", "the schema migration window", "the canary rollout"] },
  { domain: "on-call rota", subjects: ["the weekday on-call rota", "the weekend escalation path"] },
  { domain: "office facilities", subjects: ["the bike room fob", "the visitor badge system", "the locker assignment"] },
  { domain: "expense policy", subjects: ["the train fare cap", "the airfare approval rule", "the team lunch budget"] },
  // --- adjacent: insurance / permits / policies ------------------------------
  { domain: "contents insurance", subjects: ["the flat contents policy", "the studio equipment cover"] },
  { domain: "car insurance", subjects: ["the car policy renewal", "the named-driver add-on"] },
  { domain: "gym membership", subjects: ["the pool membership", "the climbing wall induction"] },
  { domain: "library account", subjects: ["the library card PIN", "the interlibrary loan limit"] },
  // --- adjacent: pets (item: Biscuit the dog) --------------------------------
  { domain: "pet care", subjects: ["Mochi the cat", "Pepper the terrier", "the neighbour's rabbit"] },
  { domain: "vet visits", subjects: ["the cat's annual booster", "the terrier's dental check"] },
  // --- adjacent: sport (item: volleyball league) ------------------------------
  { domain: "five-a-side football", subjects: ["the Tuesday five-a-side league", "the works tournament"] },
  { domain: "climbing club", subjects: ["the bouldering league", "the Thursday rope session"] },
  { domain: "running club", subjects: ["the Saturday parkrun", "the winter handicap series"] },
  // --- adjacent: home / personal admin ---------------------------------------
  { domain: "home maintenance", subjects: ["the boiler service", "the gutter clearing", "the alarm battery"] },
  { domain: "utilities", subjects: ["the electricity tariff", "the water meter reading", "the broadband contract"] },
  { domain: "car ownership", subjects: ["the MOT due date", "the tyre pressure", "the service interval"] },
  { domain: "garden", subjects: ["the allotment rota", "the compost delivery", "the greenhouse shading"] },
  // --- unrelated everyday domains --------------------------------------------
  { domain: "cooking", subjects: ["the sourdough schedule", "the pressure cooker", "the spice restock"] },
  { domain: "music", subjects: ["the guitar restringing", "the choir rehearsal", "the piano tuning"] },
  { domain: "language learning", subjects: ["the Spanish evening class", "the Duolingo streak"] },
  { domain: "hiking", subjects: ["the Coast path weekend", "the new boots"] },
  { domain: "photography", subjects: ["the film camera", "the darkroom course"] },
  { domain: "swimming", subjects: ["the lido season pass", "the Tuesday lane session"] },
  { domain: "knitting", subjects: ["the scarf pattern", "the wool order"] },
  { domain: "chess", subjects: ["the club night", "the online ladder"] },
  { domain: "fermentation", subjects: ["the kimchi batch", "the kombucha scoby"] },
  { domain: "astronomy", subjects: ["the meteor shower", "the telescope collimation"] },
  { domain: "woodworking", subjects: ["the shelf project", "the sharpening stones"] },
  { domain: "film society", subjects: ["the monthly screening", "the membership renewal"] },
  { domain: "board games", subjects: ["the Friday games night", "the legacy campaign"] },
  { domain: "cycling", subjects: ["the chain replacement", "the Sunday club ride"] },
  { domain: "houseplants", subjects: ["the monstera repotting", "the watering rota"] },
  { domain: "baking", subjects: ["the birthday cake order", "the sourdough discard crackers"] },
  { domain: "travel admin", subjects: ["the passport renewal", "the railcard expiry"] },
  { domain: "dentist & optician", subjects: ["the dental hygienist slot", "the eye test"] },
  { domain: "school logistics", subjects: ["the parents' evening", "the packed-lunch rota"] },
  { domain: "volunteering", subjects: ["the food bank shift", "the canal cleanup"] },
  { domain: "reading", subjects: ["the book club pick", "the library hold queue"] },
  { domain: "home office", subjects: ["the desk chair", "the monitor arm"] },
];

const ASPECTS = [
  "a schedule or time change",
  "a price, cap or quantity",
  "a policy or rule",
  "a person responsible",
  "an identifier or reference number",
  "a preference or habit",
  "a date or deadline",
  "a location",
  "a status update",
  "a contact detail",
];

// Ban lists derived from the dataset itself — an answer-bearing distractor
// rigs the instrument, and it would not look wrong.
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const banned = new Set<string>();
for (const item of THESIS_ITEMS) {
  for (const text of [...item.answers.filter((a) => a.length >= 4), ...item.bridgeTerms, ...item.requiredFacts]) {
    banned.add(normalize(text));
  }
}
for (const properNoun of [
  "biscuit", "hartley", "meridian mutual", "helsinki", "priya", "marcus",
  "obsidian", "syncthing", "notion", "p 8814", "p 9032", "hc 2201", "mm 8810",
]) {
  banned.add(properNoun);
}

async function chat(prompt: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.9, response_format: { type: "json_object" }, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) throw new Error(`${MODEL}: OpenAI ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

type Note = { title: string; text: string; domain: string };

function batchPrompt(domain: string, subjects: string[], aspect: string, count: number): string {
  return `Write ${count} short personal-knowledge notes as JSON: {"notes":[{"title":"3-6 word title","text":"one single-line sentence"}]}

Each note states ONE durable everyday fact about ${domain} — specifically about ${subjects.join(" / ")} — giving ${aspect}. Vary the subjects across the notes. Include concrete specifics (names, times, prices, dates, reference numbers) — they should read like entries in a personal memory store, not advice.

Hard rules:
- ONE line per note, ONE fact per note, plain prose (no markdown, no lists).
- Notes must be unrelated to each other — no two notes about the same specific thing.
- No instructions, opinions or questions; just facts someone would jot down.`;
}

async function main(): Promise<void> {
  const batchCount = Math.ceil(COUNT / BATCH);
  const notes: Note[] = [];
  const seen = new Set<string>();
  let droppedBanned = 0;
  let droppedDupe = 0;
  let droppedShape = 0;
  let completed = 0;

  const jobs = Array.from({ length: batchCount }, (_, i) => {
    const entry = DOMAINS[i % DOMAINS.length] as (typeof DOMAINS)[number];
    const aspect = ASPECTS[Math.floor(i / DOMAINS.length) % ASPECTS.length] as string;
    return { entry, aspect, index: i };
  });

  async function worker(queue: typeof jobs): Promise<void> {
    for (const job of queue) {
      let parsed: { notes?: Array<{ title?: string; text?: string }> } | null = null;
      for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
        try {
          parsed = JSON.parse(await chat(batchPrompt(job.entry.domain, job.entry.subjects, job.aspect, BATCH))) as typeof parsed;
        } catch {
          parsed = null;
        }
      }
      for (const raw of parsed?.notes ?? []) {
        const title = (raw.title ?? "").trim();
        const text = (raw.text ?? "").trim();
        if (title.length < 3 || text.length < 20 || text.includes("\n")) {
          droppedShape += 1;
          continue;
        }
        const hay = normalize(`${title} ${text}`);
        if ([...banned].some((needle) => needle.length > 0 && hay.includes(needle))) {
          droppedBanned += 1;
          continue;
        }
        const key = normalize(text);
        if (seen.has(key)) {
          droppedDupe += 1;
          continue;
        }
        seen.add(key);
        notes.push({ title, text, domain: job.entry.domain });
      }
      completed += 1;
      if (completed % 20 === 0) console.log(`  ${completed}/${jobs.length} batches, ${notes.length} notes kept`);
    }
  }

  // Small in-process pool, no dependency.
  const queues = Array.from({ length: CONCURRENCY }, () => [] as typeof jobs);
  jobs.forEach((job, i) => (queues[i % CONCURRENCY] as typeof jobs).push(job));
  await Promise.all(queues.map(worker));

  const corpus = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    requested: COUNT,
    count: notes.length,
    domains: DOMAINS.length,
    notes,
  };
  await writeFile(OUT, JSON.stringify(corpus, null, 1));
  console.log(`\nwrote ${notes.length} notes to bench/thesis/distractors.json`);
  console.log(`dropped: ${droppedBanned} banned-string, ${droppedDupe} duplicate, ${droppedShape} malformed`);
  if (notes.length < COUNT * 0.95) {
    console.log(`WARNING: kept ${notes.length}/${COUNT} — re-run to top up, or lower the target`);
  }
}

await main();
