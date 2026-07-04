import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { plainText, renderDocument } from "@/lib/markdown";
import { formatWhen } from "@/lib/viz";
import { fetchNode, fetchSource, type Stats } from "@/lib/api";

type ActivityEvent = Stats["recentEvents"][number];

// Muted-pastel action badges (identity also carried by the text itself).
const ACTION_TONES: Record<string, string> = {
  capture: "bg-[#EDF3EC] text-[#346538] dark:bg-[#1d2a1e] dark:text-[#8fbf94]",
  ingest: "bg-[#E1F3FE] text-[#1F6C9F] dark:bg-[#16283a] dark:text-[#7fb6e0]",
  link: "bg-[#FBF3DB] text-[#956400] dark:bg-[#2e2713] dark:text-[#d3a94e]",
  update: "bg-[#E1F3FE] text-[#1F6C9F] dark:bg-[#16283a] dark:text-[#7fb6e0]",
  annotate: "bg-[#EDF3EC] text-[#346538] dark:bg-[#1d2a1e] dark:text-[#8fbf94]",
  invalidate_edge: "bg-[#FDEBEC] text-[#9F2F2D] dark:bg-[#331b1c] dark:text-[#e09393]",
};

type EventDetail =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "plain" }
  | { kind: "source"; title: string; uri: string | null; html: string; truncated: boolean }
  | { kind: "node"; title: string; type: string; summary: string | null };

const PREVIEW_CHARS = 6000;

function EventDialog({ event, onClose }: { event: ActivityEvent | null; onClose: () => void }) {
  const [detail, setDetail] = useState<EventDetail>({ kind: "loading" });

  useEffect(() => {
    if (!event) return;
    let cancelled = false;
    setDetail({ kind: "loading" });

    const load = async () => {
      try {
        if (event.entityTable === "source") {
          const source = await fetchSource(event.entityId);
          // An episode is one entry of a logical file; show the entry itself,
          // it is exactly what this ingest event wrote.
          const text = source.contentText;
          const truncated = text.length > PREVIEW_CHARS;
          if (!cancelled) {
            setDetail({
              kind: "source",
              title: source.title,
              uri: source.uri,
              html: renderDocument(truncated ? `${text.slice(0, PREVIEW_CHARS)}\n\n…` : text),
              truncated,
            });
          }
          return;
        }
        if (event.entityTable === "node") {
          const node = await fetchNode(event.entityId);
          if (!cancelled) {
            setDetail({
              kind: "node",
              title: node.node.title,
              type: node.node.type,
              summary: node.node.summary,
            });
          }
          return;
        }
        if (!cancelled) setDetail({ kind: "plain" });
      } catch {
        if (!cancelled) setDetail({ kind: "missing" });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [event]);

  return (
    <Dialog open={event !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-hidden rounded-lg border bg-card p-0 shadow-none sm:max-w-xl">
        {event ? (
          <div className="flex max-h-[80vh] flex-col">
            <DialogHeader className="border-b px-5 pb-4 pt-5 text-left">
              <DialogTitle className="flex items-center gap-3 text-sm font-medium">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.05em] ${
                    ACTION_TONES[event.action] ?? "bg-muted text-muted-foreground"
                  }`}
                >
                  {event.action.replaceAll("_", " ")}
                </span>
                <span className="text-muted-foreground">{event.entityTable}</span>
              </DialogTitle>
              <DialogDescription className="pt-1 font-mono text-[11px]">
                {event.actorHandle ?? event.interfaceId ?? "system"} · {formatWhen(event.createdAt)} ·{" "}
                {new Date(event.createdAt).toLocaleString()}
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {detail.kind === "loading" ? (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              ) : null}
              {detail.kind === "missing" ? (
                <p className="text-sm text-muted-foreground">
                  This record no longer exists. It was likely test data that has since been cleaned
                  up, or a soft-deleted entry; the audit event remains as history.
                </p>
              ) : null}
              {detail.kind === "plain" ? (
                <p className="font-mono text-xs text-muted-foreground">
                  {event.entityTable} {event.entityId}
                </p>
              ) : null}
              {detail.kind === "node" ? (
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    {detail.type}
                  </p>
                  <h3 className="mt-1 font-serif text-lg leading-snug">{detail.title}</h3>
                  {detail.summary ? (
                    <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                      {plainText(detail.summary)}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {detail.kind === "source" ? (
                <div>
                  <h3 className="font-serif text-lg leading-snug">{detail.title}</h3>
                  {detail.uri ? (
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">{detail.uri}</p>
                  ) : null}
                  <div
                    className="doc-prose mt-3 border-t pt-3"
                    dangerouslySetInnerHTML={{ __html: detail.html }}
                  />
                  {detail.truncated ? (
                    <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                      Preview truncated. Open the node in the Graph view for the full document.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function RecentActivity({ stats }: { stats: Stats }) {
  const [selected, setSelected] = useState<ActivityEvent | null>(null);

  return (
    <>
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
            <TableRow
              key={event.id}
              onClick={() => setSelected(event)}
              className="cursor-pointer"
            >
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
      <EventDialog event={selected} onClose={() => setSelected(null)} />
    </>
  );
}

