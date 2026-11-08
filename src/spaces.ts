import { SPACE_RULES } from "./contracts.js";
import type { GraphOperationContext } from "./graphCore.js";

export class TeamSpaceError extends Error {
  constructor(
    public readonly code: "no_team" | "credential_in_team_write" | "space_required",
    message: string,
  ) {
    super(message);
  }
}

// ponytail: pattern list, not a scanner; catches the token shapes and password-bearing URLs seen in real notes.
const CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bdapi[a-f0-9]{30,}/,
  /\btrove_[a-f0-9]{40}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
const URL_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@([^\s/:?]+)/gi;
const SECRET_ASSIGNMENT = /\b[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|token|private[_-]?key|key)[A-Za-z0-9_]*["'`]?\s*(?:[:=]|\|)\s*["'`]?([A-Za-z0-9+/_=.-]{16,})/gi;
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|host\.docker\.internal)$/i;
const PLACEHOLDER = /^(?:<.*>|\$\{.*\}|\$[A-Z_]+|\*+|x+|password|postgres|changeme)$/i;

/** True when text holds something that works as a credential: a known token shape, a password in a non-local URL, or a long random value assigned to a secret-named key. */
export function looksLikeCredential(text: string): boolean {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const [, password, host] of text.matchAll(URL_WITH_PASSWORD)) {
    if (!LOCAL_HOST.test(host!) && !PLACEHOLDER.test(password!)) return true;
  }
  for (const [, value] of text.matchAll(SECRET_ASSIGNMENT)) {
    if (/[A-Za-z]/.test(value!) && /\d/.test(value!)) return true;
  }
  return false;
}

/**
 * The context a write runs in. A team member must name the space, since a note in
 * the wrong one cannot be unseen. A team write runs as the team's shared space, so any
 * member revises the same team note; it is refused when no team is active or the text
 * looks like a credential.
 */
export function contextForSpace(
  space: "mine" | "team" | undefined,
  context: GraphOperationContext | undefined,
  text: string,
): GraphOperationContext | undefined {
  const team = context?.sharedOwnerIds?.[0];
  if (!space && team) throw new TeamSpaceError("space_required", `Choose where this goes and call again with space. ${SPACE_RULES}`);
  if ((space ?? "mine") === "mine") return context;
  if (!team) {
    throw new TeamSpaceError("no_team", 'No team is active, so there is no team space to write to. Switch to a team in the dashboard, or write with space: "mine".');
  }
  if (looksLikeCredential(text)) {
    throw new TeamSpaceError("credential_in_team_write", 'This looks like it contains a credential, so it was not saved to the team. Remove the secret, or save it with space: "mine".');
  }
  return { ...context, ownerId: team, sharedOwnerIds: undefined };
}
