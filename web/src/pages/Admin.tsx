import { useCallback, useEffect, useState } from "react";
import { fetchUsers, setUserStatus, type AppUser } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATUS_LABEL: Record<AppUser["status"], string> = {
  active: "Active",
  waitlisted: "Waitlisted",
  suspended: "Suspended",
};

const STATUS_STYLE: Record<AppUser["status"], string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  waitlisted: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  suspended: "bg-red-500/10 text-red-700 dark:text-red-400",
};

const STATUS_DOT: Record<AppUser["status"], string> = {
  active: "bg-emerald-500",
  waitlisted: "bg-amber-500",
  suspended: "bg-red-500",
};

const STATUS_OPTIONS: Array<{ value: AppUser["status"]; hint: string }> = [
  { value: "active", hint: "full access" },
  { value: "waitlisted", hint: "no access" },
  { value: "suspended", hint: "blocked" },
];

export function Admin({ selfClerkUserId }: { selfClerkUserId?: string }) {
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const changeStatus = async (clerkUserId: string, status: AppUser["status"]) => {
    setBusy(clerkUserId);
    setError(null);
    try {
      await setUserStatus(clerkUserId, status);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update access.");
    } finally {
      setBusy(null);
    }
  };

  const waitlisted = (users ?? []).filter((user) => user.status === "waitlisted");

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h2 className="font-serif text-2xl tracking-tight">Admin</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Every sign-up lands on the waitlist. Grant access to let a member create API keys and use the graph, or revoke it at any time.
      </p>

      {error && <p className="mt-4 text-[13px] text-red-600 dark:text-red-400">{error}</p>}

      {waitlisted.length > 0 && (
        <p className="mt-4 rounded-md border border-amber-600/30 bg-amber-500/5 px-4 py-2.5 text-[13px]">
          {waitlisted.length} sign-up{waitlisted.length === 1 ? "" : "s"} waiting for access.
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
              <th className="px-5 py-3 font-medium">Access</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users === null ? (
              <tr><td colSpan={5} className="px-5 py-6 text-[13px] text-muted-foreground">Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="px-5 py-6 text-[13px] text-muted-foreground">No users yet.</td></tr>
            ) : users.map((user) => {
              const isSelf = !!selfClerkUserId && user.clerkUserId === selfClerkUserId;
              return (
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
                  <td className="px-5 py-3">
                    {isSelf ? (
                      <span className="text-[12px] text-muted-foreground">You</span>
                    ) : (
                      <Select
                        value={user.status}
                        disabled={busy === user.clerkUserId}
                        onValueChange={(value) => void changeStatus(user.clerkUserId, value as AppUser["status"])}
                      >
                        <SelectTrigger size="sm" className="w-[150px] text-[12px]">
                          <SelectValue>
                            <span className="flex items-center gap-2">
                              <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[user.status]}`} />
                              {STATUS_LABEL[user.status]}
                            </span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent align="end">
                          {STATUS_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value} className="text-[12px]">
                              <span className="flex items-center gap-2">
                                <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[option.value]}`} />
                                {STATUS_LABEL[option.value]}
                                <span className="text-muted-foreground">· {option.hint}</span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
