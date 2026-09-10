import assert from "node:assert/strict";
import test from "node:test";
import { RetrievalTravel, easeTravel, flightDuration } from "../web/src/lib/graph3DTravel.js";
const known = new Set(["seed", "neighbor", "answer"]);
const lit = (entries: Array<[string, number]>) => new Map(entries.map(([id, at]) => [id, { state: "seed" as const, hops: 0, at }]));

test("camera visits only known retrieved nodes, in event order, without duplicate stops", () => {
  const travel = new RetrievalTravel();
  travel.ingest(new Map(), known);
  const events = lit([["neighbor", 2], ["unknown", 0], ["seed", 1]]);
  travel.ingest(events, known);
  travel.ingest(events, known);
  assert.equal(travel.next(), "seed");
  assert.equal(travel.next(), "neighbor");
  assert.equal(travel.next(), undefined);
});
test("orbit interruption persists through later events until a new question begins", () => {
  const travel = new RetrievalTravel();
  travel.ingest(lit([["seed", 1]]), known);
  travel.interrupt();
  travel.ingest(lit([["seed", 1], ["neighbor", 2]]), known);
  assert.equal(travel.next(), undefined);
  travel.ingest(new Map(), known);
  travel.ingest(lit([["answer", 3]]), known);
  assert.equal(travel.next(), "answer");
});
test("closing chat clears all pending movement", () => {
  const travel = new RetrievalTravel();
  travel.ingest(lit([["seed", 1]]), known);
  travel.ingest(null, known);
  assert.equal(travel.active, false);
  assert.equal(travel.pending, false);
});
test("large recalls have bounded camera stops and easing never overshoots", () => {
  const travel = new RetrievalTravel();
  const ids = Array.from({ length: 50 }, (_, i) => String(i));
  travel.ingest(lit(ids.map((id, i) => [id, i])), new Set(ids));
  const visits: string[] = [];
  while (travel.pending) visits.push(travel.next()!);
  assert.deepEqual(visits, ids.slice(-5));
  assert.equal(easeTravel(-1), 0);
  assert.equal(easeTravel(1.2), 1);
  assert.equal(easeTravel(0.5), 0.5);
  assert.equal(flightDuration(0), 1000);
  assert.equal(flightDuration(10000), 1800);
});
