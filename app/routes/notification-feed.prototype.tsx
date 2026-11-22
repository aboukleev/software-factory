// PROTOTYPE ONLY: Three Notification Feed interaction models, switchable via ?variant=.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  ExternalLink,
  Inbox,
  LoaderCircle,
  MessageSquareReply,
  RefreshCw,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";

type Persona = "student" | "instructor";
type DemoState = "ready" | "empty" | "loading" | "error";
type Notification = {
  id: number;
  actor: string;
  action: string;
  excerpt: string;
  course: string;
  lesson: string;
  age: string;
  unread: boolean;
};

const studentNotifications: Notification[] = [
  {
    id: 1,
    actor: "Maya Chen",
    action: "replied to your Question",
    excerpt: "Exactly — the closure keeps the previous count between calls…",
    course: "TypeScript Patterns",
    lesson: "Closures in practice",
    age: "2 min ago",
    unread: true,
  },
  {
    id: 2,
    actor: "Owen Brooks",
    action: "replied to your Question",
    excerpt: "Try narrowing the union before reading the payload property.",
    course: "Advanced React",
    lesson: "Reducer design",
    age: "Yesterday",
    unread: true,
  },
  {
    id: 3,
    actor: "Priya Shah",
    action: "replied to your Question",
    excerpt: "The exercise expects the generic on the outer function.",
    course: "TypeScript Patterns",
    lesson: "Generic constraints",
    age: "4 days ago",
    unread: false,
  },
];

const instructorNotifications: Notification[] = [
  {
    id: 4,
    actor: "Alex Rivera",
    action: "asked a Question",
    excerpt: "Why does this effect run twice when I only changed the input once?",
    course: "Advanced React",
    lesson: "Effects and synchronization",
    age: "8 min ago",
    unread: true,
  },
  {
    id: 5,
    actor: "Sam Taylor",
    action: "asked a Question",
    excerpt: "Is the discriminant required to be a string literal?",
    course: "TypeScript Patterns",
    lesson: "Discriminated unions",
    age: "31 min ago",
    unread: true,
  },
  {
    id: 6,
    actor: "Jordan Lee",
    action: "asked a Question",
    excerpt: "I can make this pass, but I don't understand why inference works.",
    course: "TypeScript Patterns",
    lesson: "Inference boundaries",
    age: "Yesterday",
    unread: false,
  },
];

const variantNames = {
  A: "Dedicated feed",
  B: "Quick popover",
  C: "Context drawer",
} as const;
type Variant = keyof typeof variantNames;

export function meta() {
  return [{ title: "Notification Feed prototype — Cadence" }];
}

function usePrototypeState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const variant = (searchParams.get("variant") ?? "A") as Variant;
  const persona = (searchParams.get("persona") ?? "student") as Persona;
  const demoState = (searchParams.get("state") ?? "ready") as DemoState;
  const open = searchParams.get("open") !== "0";
  const seed = persona === "student" ? studentNotifications : instructorNotifications;
  const [readIds, setReadIds] = useState<number[]>([]);
  const notifications = useMemo(
    () => seed.map((item) => ({ ...item, unread: item.unread && !readIds.includes(item.id) })),
    [seed, readIds]
  );

  function update(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  function changeVariant(nextVariant: Variant) {
    const next = new URLSearchParams(searchParams);
    next.set("variant", nextVariant);
    next.set("open", "1");
    setSearchParams(next, { replace: true });
  }

  return {
    variant,
    persona,
    demoState,
    open,
    notifications,
    readIds,
    update,
    changeVariant,
    markRead: (id: number) => setReadIds((ids) => [...new Set([...ids, id])]),
    markAllRead: () => setReadIds(seed.map((item) => item.id)),
  };
}

function StateControls({
  persona,
  demoState,
  update,
}: {
  persona: Persona;
  demoState: DemoState;
  update: (key: string, value: string) => void;
}) {
  return (
    <div className="fixed right-4 top-4 z-50 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-2 text-xs shadow-lg backdrop-blur">
      <span className="font-semibold">Prototype state</span>
      <select
        aria-label="Persona"
        value={persona}
        onChange={(event) => update("persona", event.target.value)}
        className="rounded border bg-background px-2 py-1"
      >
        <option value="student">Student</option>
        <option value="instructor">Instructor</option>
      </select>
      <select
        aria-label="Feed state"
        value={demoState}
        onChange={(event) => update("state", event.target.value)}
        className="rounded border bg-background px-2 py-1"
      >
        <option value="ready">Ready</option>
        <option value="empty">Empty</option>
        <option value="loading">Loading</option>
        <option value="error">Error</option>
      </select>
    </div>
  );
}

function FeedState({
  demoState,
  compact = false,
  children,
}: {
  demoState: DemoState;
  compact?: boolean;
  children: React.ReactNode;
}) {
  if (demoState === "loading") {
    return (
      <div role="status" className="grid min-h-64 place-items-center p-8 text-center text-muted-foreground">
        <div><LoaderCircle className="mx-auto mb-3 size-6 animate-spin" /><p>Loading Notifications…</p></div>
      </div>
    );
  }
  if (demoState === "error") {
    return (
      <div role="alert" className="grid min-h-64 place-items-center p-8 text-center">
        <div className="max-w-xs"><AlertCircle className="mx-auto mb-3 size-7 text-destructive" /><h3 className="font-semibold">Notifications couldn't load</h3><p className="mt-1 text-sm text-muted-foreground">Your course activity is safe. Try again in a moment.</p><button className="mt-4 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm"><RefreshCw className="size-4" />Try again</button></div>
      </div>
    );
  }
  if (demoState === "empty") {
    return (
      <div className="grid min-h-64 place-items-center p-8 text-center">
        <div className="max-w-xs"><Inbox className="mx-auto mb-3 size-8 text-muted-foreground" /><h3 className="font-semibold">No Notifications yet</h3><p className="mt-1 text-sm text-muted-foreground">Replies and new Questions relevant to you will appear here.</p></div>
      </div>
    );
  }
  return <div className={compact ? "divide-y" : "space-y-2"}>{children}</div>;
}

function NotificationRow({
  item,
  onOpen,
  dense = false,
}: {
  item: Notification;
  onOpen: (id: number) => void;
  dense?: boolean;
}) {
  return (
    <Link
      to="/courses/typescript-patterns/lessons/1#question-42"
      onClick={() => onOpen(item.id)}
      className={cn(
        "group relative flex gap-3 rounded-lg p-4 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        item.unread && "bg-blue-50/80 dark:bg-blue-950/25",
        dense && "rounded-none px-4 py-3"
      )}
    >
      <div className={cn("mt-1 grid size-9 shrink-0 place-items-center rounded-full", item.unread ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground")}>
        <MessageSquareReply className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <p className="text-sm"><strong>{item.actor}</strong> {item.action}</p>
          {item.unread && <span aria-label="Unread" className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-600" />}
        </div>
        <p className={cn("mt-1 text-sm text-muted-foreground", dense ? "line-clamp-1" : "line-clamp-2")}>“{item.excerpt}”</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/75">{item.course}</span><span>·</span><span>{item.lesson}</span><span>·</span><span>{item.age}</span>
        </div>
      </div>
      <ChevronRight className="mt-3 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

function VariantA(props: ReturnType<typeof usePrototypeState>) {
  return (
    <div className="mx-auto max-w-4xl px-5 py-20 sm:px-8">
      <div className="mb-7 flex items-end justify-between gap-4">
        <div><p className="mb-1 text-sm font-medium text-blue-700 dark:text-blue-300">All course activity</p><h1 className="text-3xl font-bold tracking-tight">Notifications</h1><p className="mt-2 text-muted-foreground">A focused, browsable history of relevant Questions and Replies.</p></div>
        <button onClick={props.markAllRead} className="shrink-0 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"><Check className="mr-2 inline size-4" />Mark all read</button>
      </div>
      <div className="mb-4 flex gap-2 border-b" role="tablist" aria-label="Notification filters"><button role="tab" aria-selected="true" className="border-b-2 border-foreground px-3 py-2 text-sm font-medium">All</button><button role="tab" aria-selected="false" className="px-3 py-2 text-sm text-muted-foreground">Unread ({props.notifications.filter((n) => n.unread).length})</button></div>
      <FeedState demoState={props.demoState}>{props.notifications.map((item) => <NotificationRow key={item.id} item={item} onOpen={props.markRead} />)}</FeedState>
    </div>
  );
}

function VariantB(props: ReturnType<typeof usePrototypeState>) {
  return (
    <div className="min-h-full bg-muted/30 px-5 py-20 sm:px-10">
      <div className="mx-auto max-w-4xl"><p className="text-sm text-muted-foreground">Welcome back</p><h1 className="mt-1 text-3xl font-bold">Your dashboard</h1><div className="mt-8 grid gap-4 sm:grid-cols-2"><div className="h-44 rounded-xl border bg-card p-6 shadow-sm"><div className="h-4 w-28 rounded bg-muted" /><div className="mt-7 h-8 w-40 rounded bg-muted" /></div><div className="h-44 rounded-xl border bg-card p-6 shadow-sm"><div className="h-4 w-36 rounded bg-muted" /><div className="mt-7 h-8 w-24 rounded bg-muted" /></div></div></div>
      {props.open && (
        <section aria-label="Notification Feed" className="fixed left-2 top-16 z-30 w-[calc(100vw-1rem)] overflow-hidden rounded-xl border bg-background shadow-2xl sm:left-56 sm:w-[26rem]">
          <div className="flex items-center border-b px-4 py-3"><div><h2 className="font-semibold">Notifications</h2><p className="text-xs text-muted-foreground">{props.notifications.filter((n) => n.unread).length} unread</p></div><button onClick={props.markAllRead} className="ml-auto text-xs font-medium text-blue-700 dark:text-blue-300">Mark all read</button><button onClick={() => props.update("open", "0")} aria-label="Close Notification Feed" className="ml-3 rounded p-1 hover:bg-muted"><X className="size-4" /></button></div>
          <div className="max-h-[min(68vh,38rem)] overflow-y-auto"><FeedState demoState={props.demoState} compact>{props.notifications.map((item) => <NotificationRow key={item.id} item={item} onOpen={props.markRead} dense />)}</FeedState></div>
          <div className="border-t p-2 text-center"><button onClick={() => props.changeVariant("A")} className="text-sm font-medium">Open full Notification Feed <ExternalLink className="ml-1 inline size-3.5" /></button></div>
        </section>
      )}
    </div>
  );
}

function VariantC(props: ReturnType<typeof usePrototypeState>) {
  return (
    <div className="relative min-h-full px-5 py-20 sm:px-10">
      <div className="mx-auto max-w-5xl"><div className="flex items-center justify-between"><div><p className="text-sm text-muted-foreground">Course</p><h1 className="text-3xl font-bold">TypeScript Patterns</h1></div><button onClick={() => props.update("open", props.open ? "0" : "1")} aria-label="Toggle Notification Feed" className="relative rounded-full border bg-background p-3 shadow-sm hover:bg-muted"><Bell className="size-5" /><span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-blue-600 px-1 text-center text-xs leading-5 text-white">3</span></button></div><div className="mt-8 aspect-video max-w-3xl rounded-xl bg-zinc-900" /><h2 className="mt-6 text-xl font-semibold">Discriminated unions</h2><p className="mt-2 max-w-2xl text-muted-foreground">Learn how a shared literal property makes complex unions safe to narrow.</p></div>
      {props.open && <button aria-label="Close Notification Feed overlay" onClick={() => props.update("open", "0")} className="fixed inset-0 z-20 cursor-default bg-black/15" />}
      <aside aria-label="Notification Feed" className={cn("fixed bottom-0 right-0 top-0 z-30 flex w-full max-w-md flex-col border-l bg-background shadow-2xl transition-transform duration-200", !props.open && "translate-x-full")}>
        <div className="flex items-center gap-3 border-b p-4"><button onClick={() => props.update("open", "0")} aria-label="Close Notification Feed" className="rounded p-2 hover:bg-muted"><ArrowRight className="size-4" /></button><div><h2 className="font-semibold">Notification Feed</h2><p className="text-xs text-muted-foreground">Stay in context while checking activity</p></div><button onClick={props.markAllRead} className="ml-auto text-xs font-medium">Mark all read</button></div>
        <div className="flex-1 overflow-y-auto"><FeedState demoState={props.demoState} compact>{props.notifications.map((item) => <NotificationRow key={item.id} item={item} onOpen={props.markRead} dense />)}</FeedState></div>
      </aside>
    </div>
  );
}

function PrototypeSwitcher({ current, onChange }: { current: Variant; onChange: (variant: Variant) => void }) {
  const variants = Object.keys(variantNames) as Variant[];
  function cycle(offset: number) { const index = variants.indexOf(current); onChange(variants[(index + offset + variants.length) % variants.length]); }
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, select, [contenteditable]")) return;
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  return (
    <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center rounded-full bg-zinc-950 p-1 text-white shadow-2xl ring-1 ring-white/15">
      <button onClick={() => cycle(-1)} aria-label="Previous variant" className="rounded-full p-2 hover:bg-white/15"><ArrowLeft className="size-4" /></button>
      <div className="min-w-48 px-3 text-center text-xs"><strong>{current}</strong> · {variantNames[current]}</div>
      <button onClick={() => cycle(1)} aria-label="Next variant" className="rounded-full p-2 hover:bg-white/15"><ArrowRight className="size-4" /></button>
    </div>
  );
}

export default function NotificationFeedPrototype() {
  const props = usePrototypeState();
  return (
    <div className="relative min-h-full">
      <StateControls persona={props.persona} demoState={props.demoState} update={props.update} />
      {props.variant === "A" && <VariantA {...props} />}
      {props.variant === "B" && <VariantB {...props} />}
      {props.variant === "C" && <VariantC {...props} />}
      {import.meta.env.DEV && <PrototypeSwitcher current={props.variant} onChange={props.changeVariant} />}
      <div className="fixed bottom-5 right-4 z-50 hidden rounded bg-background/90 px-2 py-1 font-mono text-[10px] text-muted-foreground shadow sm:block">{JSON.stringify({ variant: props.variant, persona: props.persona, state: props.demoState, open: props.open, readIds: props.readIds })}</div>
    </div>
  );
}
