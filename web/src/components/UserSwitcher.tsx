import { useEffect, useState } from "react";
import { fetchUsers, setImpersonation, type AppUser, type Identity } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SELF = "__self__";

export function userLabel(user: { displayName?: string | null; email: string | null; clerkUserId: string }): string {
  return user.displayName || user.email || user.clerkUserId;
}

/**
 * Admin-only account switcher, in the header so it works from any page. Picking
 * someone puts the whole dashboard in their account; picking yourself returns.
 * A reload is the honest refresh here — stats, graph and keys all change owner.
 */
export function switchToUser(clerkUserId: string | null): void {
  setImpersonation(clerkUserId);
  window.location.reload();
}

export function UserSwitcher({ self, impersonating }: { self: Identity; impersonating: Identity | null }) {
  const [users, setUsers] = useState<AppUser[]>([]);

  useEffect(() => {
    void fetchUsers()
      .then((result) => setUsers(result.users))
      .catch(() => setUsers([]));
  }, []);

  // Only active accounts: the API refuses to be viewed as a waitlisted or
  // suspended user, so offering them here would just bounce you back.
  const others = users.filter((user) => user.clerkUserId !== self.clerkUserId && user.status === "active");
  // Prefer the directory row (it carries displayName); fall back to the
  // identity /v1/me confirmed, which is enough for userLabel.
  const current = impersonating
    ? users.find((user) => user.clerkUserId === impersonating.clerkUserId) ?? impersonating
    : null;

  return (
    <Select
      value={impersonating?.clerkUserId ?? SELF}
      onValueChange={(value) => switchToUser(value === SELF ? null : value)}
    >
      {/* A narrow header cannot spare 190px for a name. Below lg the trigger
          shrinks to its dot — amber still means "someone else", and the banner
          under the header spells out who — and the names return in the menu. */}
      <SelectTrigger size="sm" className="w-auto text-[12px] lg:w-[190px]" aria-label="View Trove as">
        <SelectValue>
          <span className="flex items-center gap-2 truncate">
            <span className={`size-1.5 shrink-0 rounded-full ${impersonating ? "bg-amber-500" : "bg-emerald-500"}`} />
            <span className="hidden truncate lg:inline">{current ? userLabel(current) : "Your account"}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={SELF} className="text-[12px]">
          <span className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            Your account
            <span className="text-muted-foreground">· {self.email ?? self.clerkUserId}</span>
          </span>
        </SelectItem>
        {others.map((user) => (
          <SelectItem key={user.id} value={user.clerkUserId} className="text-[12px]">
            <span className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
              {userLabel(user)}
              {user.displayName && user.email && (
                <span className="text-muted-foreground">· {user.email}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
