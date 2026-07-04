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
};

export type ResolvedApiKey = {
  userId: string;
  actorId: string;
  scopes: TroveScope[];
  status: AppUser["status"];
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
    this.pool = new Pool({ connectionString: options.connectionString, max: 4 });
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

  async approveUser(clerkUserId: string, approvedById: string): Promise<AppUser | null> {
    const result = await this.pool.query(
      `update app_user
       set status = 'active', approved_at = now(), approved_by = $2
       where clerk_user_id = $1
       returning *`,
      [clerkUserId, approvedById],
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
      `insert into user_api_key (user_id, name, key_prefix, key_hash, scopes)
       values ($1, $2, $3, $4, $5)
       returning id, name, key_prefix, scopes, created_at, last_used_at, revoked_at`,
      [userId, input.name, prefix, hash, input.scopes],
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
      `select id, name, key_prefix, scopes, created_at, last_used_at, revoked_at
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
