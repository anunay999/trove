/**
 * The two shapes a feature flag is allowed to have here, and which one to pick.
 *
 * Three copies of the same four-line `isEnabled` had accumulated — in
 * chatModel, rerank and reconcile — plus a fourth spelling of the inverse in
 * graphCore's temporal scope. Same intent, four implementations, and the kind
 * of duplication that lets defaults drift apart without anyone noticing.
 *
 * WHICH SHAPE. `optedIn` is for a feature whose cost the operator must accept
 * on purpose. `featureEnabled` is for one that should simply work once the
 * thing it needs exists, and that a deployment can still switch off.
 *
 * The distinction is not cosmetic, and getting it wrong is expensive in a way
 * that leaves no trace. Reranking and the reconcile judge were both opt-in, for
 * the good reason that neither had production mileage. Both then sat dark for
 * months in the one deployment that had a key: 1,081 reconcile jobs ran without
 * ever calling the judge, so the graph could not write a single `supersedes`
 * edge of its own, and recall shipped its unranked candidate order to every
 * answer. Nothing failed. Nothing warned. An unset opt-in flag is
 * indistinguishable from a deliberate "no", which means a feature behind one is
 * only as live as somebody's memory of the day it merged.
 *
 * So: opt-in buys caution while a thing is unproven, and it is a debt to be
 * paid off once it is. Default-on with an off switch is the resting state.
 */

const OFF = new Set(["0", "false", "off", "no"]);
const ON = new Set(["1", "true", "yes", "on"]);

/**
 * Off unless explicitly turned on. For features whose cost an operator must
 * accept deliberately — a per-answer model spend, a projection nobody asked for.
 */
export function optedIn(value: string | undefined): boolean {
  return value !== undefined && ON.has(value.trim().toLowerCase());
}

/**
 * On unless explicitly turned off. For features that should work as soon as
 * their prerequisite exists; the caller still checks that prerequisite, so this
 * only answers "has someone asked for it to stop".
 */
export function featureEnabled(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !OFF.has(raw);
}
