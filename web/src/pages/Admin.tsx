import { useCallback, useEffect, useState } from "react";
import { approveUser, fetchUsers, type AppUser } from "@/lib/api";

const STATUS_STYLE: Record<AppUser["status"], string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  waitlisted: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  suspended: "bg-red-500/10 text-red-700 dark:text-red-400",
};

export function Admin() {
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchUsers();
      setUsers(result.users);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load users.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (clerkUserId: string) => {
    setApproving(clerkUserId);
    try {
      await approveUser(clerkUserId);
      await load();
    } finally {
      setApproving(null);
    }
  };

  const waitlisted = (users ?? []).filter((user) => user.status === "waitlisted");

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h2 className="font-serif text-2xl tracking-tight">Admin</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Every sign-up lands on the waitlist until approved here. Approved members can create API keys and use the dashboard.
      </p>

      {error && <p className="mt-4 text-[13px] text-red-600 dark:text-red-400">{error}</p>}

      {waitlisted.length > 0 && (
        <p className="mt-4 rounded-md border border-amber-600/30 bg-amber-500/5 px-4 py-2.5 text-[13px]">
          {waitlisted.length} sign-up{waitlisted.length === 1 ? "" : "s"} waiting for approval.
        </p>
      )}

      <div className="mt-6 overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Joined</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {users === null ? (
              <tr><td colSpan={5} className="px-5 py-6 text-[13px] text-muted-foreground">Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-6 text-[13px] text-muted-foreground">No users yet.</td></tr>
            ) : users.map((user) => (
              <tr key={user.id}>
                <td className="px-5 py-3">
                  <p className="font-medium">{user.displayName ?? user.email ?? user.clerkUserId}</p>
                  {user.email && user.displayName && (
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{user.email}</p>
                  )}
                </td>
                <td className="px-5 py-3 text-[13px] capitalize">{user.role}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.05em] ${STATUS_STYLE[user.status]}`}>
                    {user.status}
                  </span>
                </td>
                <td className="px-5 py-3 font-mono text-[12px] text-muted-foreground">{user.createdAt.slice(0, 10)}</td>
                <td className="px-5 py-3 text-right">
                  {user.status === "waitlisted" && (
                    <button
                      type="button"
                      disabled={approving === user.clerkUserId}
                      onClick={() => void approve(user.clerkUserId)}
                      className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-50"
                    >
                      {approving === user.clerkUserId ? "Approving…" : "Approve"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
