import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatWhen } from "@/lib/viz";
import type { Stats } from "@/lib/api";

// Muted-pastel action badges (identity also carried by the text itself).
const ACTION_TONES: Record<string, string> = {
  capture: "bg-[#EDF3EC] text-[#346538] dark:bg-[#1d2a1e] dark:text-[#8fbf94]",
  ingest: "bg-[#E1F3FE] text-[#1F6C9F] dark:bg-[#16283a] dark:text-[#7fb6e0]",
  link: "bg-[#FBF3DB] text-[#956400] dark:bg-[#2e2713] dark:text-[#d3a94e]",
  update: "bg-[#E1F3FE] text-[#1F6C9F] dark:bg-[#16283a] dark:text-[#7fb6e0]",
  annotate: "bg-[#EDF3EC] text-[#346538] dark:bg-[#1d2a1e] dark:text-[#8fbf94]",
  invalidate_edge: "bg-[#FDEBEC] text-[#9F2F2D] dark:bg-[#331b1c] dark:text-[#e09393]",
};

export function RecentActivity({ stats }: { stats: Stats }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="font-mono text-[11px] uppercase tracking-[0.08em]">Action</TableHead>
          <TableHead className="font-mono text-[11px] uppercase tracking-[0.08em]">Target</TableHead>
          <TableHead className="font-mono text-[11px] uppercase tracking-[0.08em]">Actor</TableHead>
          <TableHead className="text-right font-mono text-[11px] uppercase tracking-[0.08em]">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stats.recentEvents.map((event) => (
          <TableRow key={event.id}>
            <TableCell>
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] ${
                  ACTION_TONES[event.action] ?? "bg-muted text-muted-foreground"
                }`}
              >
                {event.action.replaceAll("_", " ")}
              </span>
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">{event.entityTable}</TableCell>
            <TableCell className="max-w-36 truncate font-mono text-xs text-muted-foreground">
              {event.actorHandle ?? event.interfaceId ?? "system"}
            </TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {formatWhen(event.createdAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
