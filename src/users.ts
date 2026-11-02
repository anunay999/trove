import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import type { TroveScope } from "./auth.js";

const { Pool } = pg;

export type AppUser = {
  id: string;
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
  role: "admin" | "member";
  status: "waitlisted" | "active" | "suspended";
  createdAt: string;
  approvedAt: string | null;
};

export type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: TroveScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Retrievable secret; null for keys minted before migration 005. */
  secret: string | null;
};

export type ResolvedApiKey = {
  userId: string;
  actorId: string;
  scopes: TroveScope[];
  status: AppUser["status"];
};

export type Spaces = {
  /** Null only if the user has no personal tenant row. */
  tenantId: string | null;
  /** Null for the personal tenant. */
  clerkOrgId: string | null;
  ownerId: string;
  sharedOwnerIds: string[];
};

export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `trove_${randomBytes(20).toString("hex")}`;
  return { secret, prefix: secret.slice(0, 12), hash: sha256(secret) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapUser(row: Record<string, unknown>): AppUser {
  return {
    id: String(row.id),
    clerkUserId: String(row.clerk_user_id),
    email: row.email == null ? null : String(row.email),
    displayName: row.display_name == null ? null : String(row.display_name),
    role: row.role as AppUser["role"],
    status: row.status as AppUser["status"],
    createdAt: new Date(row.created_at as string).toISOString(),
    approvedAt: row.approved_at == null ? null : new Date(row.approved_at as string).toISOString(),
  };
}

export class UserStore {
  private pool: pg.Pool;

  constructor(options: { connectionString: string }) {
    this.pool = new Pool({ connectionString: options.connectionString, max: 4, keepAlive: true });
    this.pool.on("error", (error) => {
      console.error("[pg-pool] idle client error:", error.message);
    });
  }

  async ensureUser(
    input: { clerkUserId: string; email?: string | null; displayName?: string | null },
    options: { adminEmails?: string[] } = {},
  ): Promise<AppUser> {
    const adminEmails = (options.adminEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean);
    const isAdmin = !!input.email && adminEmails.includes(input.email.trim().toLowerCase());
    const result = await this.pool.query(
      `insert into app_user (clerk_user_id, email, display_name, role, status, approved_at)
       values ($1, $2, $3, $4, $5, case when $5 = 'active' then now() end)
       on conflict (clerk_user_id) do update
         set email = coalesce(excluded.email, app_user.email),
             display_name = coalesce(excluded.display_name, app_user.display_name),
             -- promote on sight, never demote
             role = case when excluded.role = 'admin' then 'admin' else app_user.role end,
             status = case when excluded.status = 'active' and app_user.status = 'waitlisted' then 'active' else app_user.status end,
             approved_at = coalesce(app_user.approved_at, case when excluded.status = 'active' then now() end)
       returning *`,
      [
        input.clerkUserId,
        input.email ?? null,
        input.displayName ?? null,
        isAdmin ? "admin" : "member",
        isAdmin ? "active" : "waitlisted",
      ],
    );
    return mapUser(result.rows[0]);
  }

  async userByClerkId(clerkUserId: string): Promise<AppUser | null> {
    const result = await this.pool.query("select * from app_user where clerk_user_id = $1", [clerkUserId]);
    return result.rowCount === 0 ? null : mapUser(result.rows[0]);
  }

  async listUsers(): Promise<AppUser[]> {
    const result = await this.pool.query("select * from app_user order by created_at desc limit 500");
    return result.rows.map(mapUser);
  }

  /**
   * The app_user that env service tokens act as: the configured
   * TROVE_SERVICE_OWNER_EMAIL if it exists, else the founding (oldest) admin.
   * Undefined only on a brand-new instance where nobody has signed in yet.
   */
  async ownerForServiceToken(preferredEmail?: string): Promise<string | undefined> {
    if (preferredEmail) {
      const byEmail = await this.pool.query(
        "select id from app_user where lower(email) = lower($1) order by created_at asc limit 1",
        [preferredEmail],
      );
      if (byEmail.rowCount) return String(byEmail.rows[0].id);
    }
    const admin = await this.pool.query(
      "select id from app_user where role = 'admin' order by created_at asc limit 1",
    );
    return admin.rowCount ? String(admin.rows[0].id) : undefined;
  }

  /**
   * The spaces a user's credentials act in: their private space in the active
   * tenant (writes) plus that tenant's shared space (reads). No active tenant,
   * or no longer a member of it, means the personal tenant.
   */
  async spacesFor(userId: string): Promise<Spaces> {
    const result = await this.pool.query(
      `select t.id as tenant_id, t.clerk_org_id, p.id as private_id, s.id as shared_id
       from app_user u
       join tenant t on t.id = u.active_tenant_id
       join tenant_member m on m.tenant_id = t.id and m.user_id = u.id
       join space p on p.tenant_id = t.id and p.kind = 'private' and p.user_id = u.id
       left join space s on s.tenant_id = t.id and s.kind = 'shared'
       where u.id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      const personal = await this.pool.query("select id from tenant where personal_user_id = $1", [userId]);
      return { tenantId: personal.rows[0] ? String(personal.rows[0].id) : null, clerkOrgId: null, ownerId: userId, sharedOwnerIds: [] };
    }
    return {
      tenantId: String(row.tenant_id),
      clerkOrgId: String(row.clerk_org_id),
      ownerId: String(row.private_id),
      sharedOwnerIds: row.shared_id ? [String(row.shared_id)] : [],
    };
  }

  /** Make a Clerk organization the user's active tenant, provisioning its rows on first sight. */
  async joinOrg(userId: string, org: { clerkOrgId: string; name: string; role: "admin" | "member" }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const tenant = await client.query(
        `insert into tenant (clerk_org_id, name) values ($1, $2)
         on conflict (clerk_org_id) do update set name = excluded.name
         returning id`,
        [org.clerkOrgId, org.name],
      );
      const tenantId = tenant.rows[0].id;
      await client.query(
        `insert into tenant_member (tenant_id, user_id, role) values ($1, $2, $3)
         on conflict (tenant_id, user_id) do update set role = excluded.role`,
        [tenantId, userId, org.role],
      );
      await client.query(
        `insert into space (tenant_id, kind, user_id) values ($1, 'private', $2)
         on conflict (tenant_id, user_id) where kind = 'private' do nothing`,
        [tenantId, userId],
      );
      await client.query(
        `insert into space (tenant_id, kind) values ($1, 'shared')
         on conflict (tenant_id) where kind = 'shared' do nothing`,
        [tenantId],
      );
      await client.query("update app_user set active_tenant_id = $2 where id = $1", [userId, tenantId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async usePersonalSpace(userId: string): Promise<void> {
    await this.pool.query("update app_user set active_tenant_id = null where id = $1", [userId]);
  }

  /** The user left (or was removed from) a Clerk organization. Their private space stays with the tenant. */
  async removeMembership(userId: string, clerkOrgId: string): Promise<void> {
    await this.pool.query(
      `delete from tenant_member m using tenant t
       where m.tenant_id = t.id and t.clerk_org_id = $2 and m.user_id = $1`,
      [userId, clerkOrgId],
    );
    await this.pool.query(
      `update app_user u set active_tenant_id = null
       from tenant t where t.id = u.active_tenant_id and t.clerk_org_id = $2 and u.id = $1`,
      [userId, clerkOrgId],
    );
  }

  async approveUser(clerkUserId: string, approvedById: string): Promise<AppUser | null> {
    return this.setUserStatus(clerkUserId, "active", approvedById);
  }

  /**
   * Admin grant/revoke: move a user between waitlisted / active / suspended.
   * Granting (active) stamps approved_at/by; revoking leaves the audit trail.
   * Scopes follow status, so a revoked user loses graph access on their next
   * request (within the 60s identity cache).
   */
  async setUserStatus(
    clerkUserId: string,
    status: AppUser["status"],
    actingAdminId: string,
  ): Promise<AppUser | null> {
    const result = await this.pool.query(
      `update app_user
       set status = $2,
           approved_at = case when $2 = 'active' then coalesce(approved_at, now()) else approved_at end,
           approved_by = case when $2 = 'active' then coalesce(approved_by, $3) else approved_by end
       where clerk_user_id = $1
       returning *`,
      [clerkUserId, status, actingAdminId],
    );
    return result.rowCount === 0 ? null : mapUser(result.rows[0]);
  }

  async createApiKey(
    userId: string,
    input: { name: string; scopes: TroveScope[] },
  ): Promise<ApiKeySummary & { secret: string }> {
    const owner = await this.pool.query("select status from app_user where id = $1", [userId]);
    if (owner.rowCount === 0 || owner.rows[0].status !== "active") {
      throw new Error("Only active users can create API keys.");
    }
    if (input.scopes.length === 0) {
      throw new Error("An API key needs at least one scope.");
    }
    const { secret, prefix, hash } = generateApiKey();
    const result = await this.pool.query(
      `insert into user_api_key (user_id, name, key_prefix, key_hash, scopes, secret)
       values ($1, $2, $3, $4, $5, $6)
       returning id, name, key_prefix, scopes, created_at, last_used_at, revoked_at`,
      [userId, input.name, prefix, hash, input.scopes, secret],
    );
    const row = result.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      keyPrefix: String(row.key_prefix),
      scopes: row.scopes as TroveScope[],
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      secret,
    };
  }

  async listApiKeys(userId: string): Promise<ApiKeySummary[]> {
    const result = await this.pool.query(
      `select id, name, key_prefix, scopes, created_at, last_used_at, revoked_at, secret
       from user_api_key where user_id = $1 order by created_at desc`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      keyPrefix: String(row.key_prefix),
      scopes: row.scopes as TroveScope[],
      createdAt: new Date(row.created_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
      secret: row.secret == null ? null : String(row.secret),
    }));
  }

  async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    const result = await this.pool.query(
      "update user_api_key set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null",
      [keyId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveApiKey(secret: string): Promise<ResolvedApiKey | null> {
    if (!secret.startsWith("trove_")) return null;
    const result = await this.pool.query(
      `select k.id, k.user_id, k.scopes, u.clerk_user_id, u.status
       from user_api_key k
       join app_user u on u.id = k.user_id
       where k.key_hash = $1 and k.revoked_at is null`,
      [sha256(secret)],
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    if (row.status !== "active") return null;
    void this.pool.query("update user_api_key set last_used_at = now() where id = $1", [row.id]).catch(() => {});
    return {
      userId: String(row.user_id),
      actorId: String(row.clerk_user_id),
      scopes: row.scopes as TroveScope[],
      status: row.status as AppUser["status"],
    };
  }

  /** Remove smoke users (and their keys via cascade) created by test suites. */
  async cleanupSmoke(clerkIdPrefix: string): Promise<void> {
    if (!clerkIdPrefix) return;
    await this.pool.query("delete from app_user where clerk_user_id like $1", [`${clerkIdPrefix}%`]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
