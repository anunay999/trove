# Tenants and workspaces: shared team memory

Status: **decided 2026-10-28; being built.** Step 1 (spaces own graph rows) is PR #135. Step 2 (Clerk
organizations become tenants) is the next PR.

## What it is

You sign in **to a tenant** (a company, or a one-person tenant made for you at sign-up). Inside a
tenant every member has a **private space**, and the tenant has one **shared workspace**. Agents
choose the space when they write: knowledge about the shared work goes to the workspace, knowledge
about the person stays private. A memory written privately can be **promoted** later, which copies
it. recall reads your private space plus the workspace and labels where each result came from.
Nothing ever crosses a tenant boundary.

Why agents choose, not a Share button: agents write almost every memory, and people rarely open the
graph. A step that someone must remember to take at write time, for a payoff that goes to a
teammate days later, leaves the workspace empty.

```
  tenant: Acme  (billing, seats, SSO, admins)
  ├── Priya's agent ──remember(space: team)──► shared workspace ◄── recall ── your agent
  └── your private space ─────────────────────────────────────────────┘
```

A person in two tenants (a contractor) has two private spaces and switches tenant in the dashboard.

## Decisions

1. **Tenants are Clerk Organizations.** Clerk already authenticates Trove. Its docs (read 2026-10-28)
   say Organizations "group users with Roles and Permissions", support invitations, an
   `<OrganizationSwitcher/>`, verified domains, and "Enterprise Connections" (SAML or OIDC), and
   "Users can belong to multiple Organizations." Free plans include "100 [MROs] in production";
   an MRO needs at least two members, so one-person tenants do not count against it. We store a
   `tenant` row keyed by the Clerk organization id.
2. **Owners become spaces.** Isolation was `owner_id → app_user` on ten graph tables
   (migration 006) through one chokepoint, `ownerScope()` in `src/graphCore.ts`. A new
   `space (id, tenant_id, kind 'private'|'shared', user_id)` table becomes the owner, and the ten
   foreign keys move from `app_user` to `space`.
   **Migration without rewriting data:** every existing user gets a tenant and a private space
   whose id *is* their user id, so every stored `owner_id` (and `embedding.tenant_id`, which holds
   the same value) stays valid; only the constraints change. Rehearsed on a clone with
   before/after row counts.
3. **Credentials act in the user's active tenant.** The dashboard's active Clerk organization
   (the session token's `o` / `org_id` claim) sets it; personal when none is active. API keys and
   OAuth tokens carry no organization, so they follow it: your agents work wherever your dashboard
   is. A credential reads its user's private space in that tenant plus the tenant's workspace and
   nothing else. Membership is rechecked against Clerk (cached 60s), so a removed member drops back
   to personal. Binding a key to a fixed tenant waits until someone needs two teams at once.
4. **Reads see a set of spaces; writes stamp one.** `OwnerScope` gains `readOwnerIds`
   (private space + workspace). Read predicates move from `owner_id = $n` to `owner_id = any($n)`.
   Writes stamp the private space unless the write names the workspace (decision 5). There are 71 `owner_id = ...` predicates in `pgStore.ts` and 19 `ownerId`
   checks in the in-memory `store.ts`; each is classified read or write in the PR, with an isolation
   test per class.
5. **Agents choose the space at write time.** `remember` and `ingest` take `space: "mine" | "team"`.
   The tool descriptions steer: facts about shared work (a repo, a service, a customer, a decision)
   go to `team`; facts about the person (preferences, their workflow, credentials, opinions about
   colleagues) stay `mine`. The default when unset is decided by a sort of ~100 real memories into
   team / personal / secret: about 70% or more team means default `team`.
   **Promote** copies a private node, the text units it cites and their sources into the
   workspace, recording `sharedFrom` and `sharedBy`. Promoting again revises the same copy. Links
   are re-made against workspace nodes with the same slug; no match links to the Unfiled hub, and
   lint flags it.
   **Remove from team** retires the workspace copy (history kept); the sharer's private original is
   untouched. Allowed for the sharer or an admin.
   A weekly digest tells each member what went to the team, with one-tap remove.
6. **recall merges** in one query over both spaces; each atom carries
   `graph: "private" | "workspace"`.
7. **Same slug in both spaces:** private wins; `workspace:<slug>` addresses the shared one.
8. **Editing a shared memory:** any member may revise it (history is kept); only the sharer or a
   tenant admin may remove or forget it.
9. **A member leaves the tenant:** their private space stays with the tenant and is frozen; admins
   cannot read it but can delete it. What they wrote to the workspace stays.
10. **Secrets never reach the workspace.** A write to the workspace is refused when it looks like a
   credential (keys, tokens, connection strings with passwords). Blocking before the write replaces
   deleting after a leak; the private space is unaffected.

## Not in v1

More than one shared workspace per tenant, per-person visibility inside a workspace, roles beyond
member/admin, watched sources (Slack channel → hub), billing. The pricing page waits on this.

## Where it goes next

The unit of access moves from the single note to what the note is about.

1. **Sharing by topic.** Share the `payments` hub and everything filed under it goes with it, like a
   Slack channel or a Notion teamspace.
2. **Access follows the source.** A memory citing a private channel or repo is visible to whoever
   can see that source. Arrives with watched sources.
3. **Agents as principals.** A CI bot or a support agent reads only the topics it is allowed to, with
   an audit of what it read. Sharing outside the company (a vendor, a customer) builds on this.

## Done means

- A member's recall returns a shared memory with its cited source text; another tenant's member's
  does not, even with a guessed node id or slug.
- A private memory never appears to another member: not in recall, grep, read, neighborhood, the
  graph explorer, or through a link from a shared node.
- After the migration every existing user sees exactly the graph they saw before (row counts and a
  recall per user compared on a clone).
- Promoting again revises one copy, never two. Removing a shared node by a non-sharer member is refused.
- A workspace write that looks like a credential is refused; the same write to the private space works.
- Each of the above is a test that was seen failing first.
