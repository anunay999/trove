# Tenants and workspaces: shared team memory

Status: **spec, awaiting sign-off** (2026-10-28). Nothing here is built yet.

## What it is

You sign in **to a tenant** (a company, or a one-person tenant made for you at sign-up). Inside a
tenant every member has a **private space**, and the tenant has one **shared workspace**. A memory
reaches the workspace only when someone **shares** it, which copies it there. recall reads your
private space plus the workspace and labels where each result came from. Nothing ever crosses a
tenant boundary.

```
  tenant: Acme  (billing, seats, SSO, admins)
  ├── Priya's private space ──share──► shared workspace ◄── recall ── your agent
  └── your private space ─────────────────────────────────────────────┘
```

A person in two tenants (a contractor) has two private spaces and switches tenant at sign-in.

## Decisions (defaults proposed; OPEN items need a call)

1. **Tenants are Clerk Organizations.** Clerk already authenticates Trove. Its docs (read 2026-10-28)
   say Organizations "group users with Roles and Permissions", support invitations, an
   `<OrganizationSwitcher/>`, verified domains, and "Enterprise Connections" (SAML or OIDC), and
   "Users can belong to multiple Organizations." Free plans include "100 [MROs] in production";
   an MRO needs at least two members, so one-person tenants do not count against it. We store a
   `tenant` row keyed by the Clerk organization id.
2. **Owners become spaces.** Isolation today is `owner_id → app_user` on seven graph tables
   (migration 006) through one chokepoint, `ownerScope()` in `src/graphCore.ts`. A new
   `space (id, tenant_id, kind 'private'|'shared', user_id)` table becomes the owner, and the seven
   foreign keys move from `app_user` to `space`.
   **Migration without rewriting data:** every existing user gets a tenant and a private space
   whose id *is* their user id, so every stored `owner_id` (and `embedding.tenant_id`, which holds
   the same value) stays valid; only the constraints change. Rehearsed on a clone with
   before/after row counts.
3. **Credentials belong to a tenant.** API keys and OAuth sessions carry the active tenant. A key
   reads its user's private space plus that tenant's workspace and nothing else.
4. **Reads see a set of spaces; writes stamp one.** `OwnerScope` gains `readOwnerIds`
   (private space + workspace). Read predicates move from `owner_id = $n` to `owner_id = any($n)`.
   Writes stamp the private space by default, the workspace only through `share` or an explicit
   workspace target. There are 71 `owner_id = ...` predicates in `pgStore.ts` and 19 `ownerId`
   checks in the in-memory `store.ts`; each is classified read or write in the PR, with an isolation
   test per class.
5. **Share copies.** `share({ slug })` copies the node, the text units it cites and their sources into
   the workspace, recording `sharedFrom` and `sharedBy` in metadata. Re-sharing revises the same
   copy. Links are re-made against workspace nodes with the same slug; a node with no match is
   linked to the workspace's Unfiled hub, and lint flags it.
6. **recall merges** in one query over both spaces; each atom carries
   `graph: "private" | "workspace"`.
7. **OPEN: same slug in both spaces.** Proposed: private wins; `workspace:<slug>` addresses the
   shared one.
8. **OPEN: who may edit or forget a shared memory.** Proposed: any member may revise it (history is
   kept); only the sharer or a tenant admin may `forget` it.
9. **OPEN: a member leaves the tenant.** Proposed: their private space stays with the tenant and is
   frozen; admins cannot read it but can delete it. What they shared stays in the workspace.

## Not in v1

More than one shared workspace per tenant, per-person visibility inside a workspace, roles beyond
member/admin, watched sources (Slack channel → hub), billing. The pricing page waits on this.

## Done means

- A member's recall returns a shared memory with its cited source text; another tenant's member's
  does not, even with a guessed node id or slug.
- A private memory never appears to another member: not in recall, grep, read, neighborhood, the
  graph explorer, or through a link from a shared node.
- After the migration every existing user sees exactly the graph they saw before (row counts and a
  recall per user compared on a clone).
- Re-sharing revises one copy, never two. `forget` on a shared node by a non-sharer member is refused.
- Each of the above is a test that was seen failing first.
