import { NavLink, Form } from "react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { cn } from "~/lib/utils";
import { UserRole } from "~/db/schema";
import { UserAvatar } from "~/components/user-avatar";
import {
  NotificationFeed,
  type NotificationFeedItem,
} from "~/components/notification-feed";
import { NotificationSync } from "~/components/notification-sync";
import { requestNotificationReconciliation } from "~/services/notificationSync";
import {
  BookOpen,
  ChartColumn,
  LayoutDashboard,
  GraduationCap,
  MessageSquare,
  Shield,
  Tag,
  Users,
  UsersRound,
  Moon,
  Sun,
  LogOut,
  Settings,
  ReceiptText,
  Bell,
} from "lucide-react";

interface CurrentUser {
  id: number;
  name: string;
  role: UserRole;
  avatarUrl: string | null;
}

interface RecentCourse {
  courseId: number;
  title: string;
  slug: string;
  coverImageUrl: string | null;
  completedLessons: number;
  totalLessons: number;
  progress: number;
}

interface SidebarProps {
  currentUser: CurrentUser | null;
  recentCourses?: RecentCourse[];
  isTeamAdmin?: boolean;
  notificationFeed?: {
    items: NotificationFeedItem[];
    unreadCount: number;
    nextCursor: string | null;
  };
}

interface NavItem {
  label: string;
  to: string;
  icon: React.ReactNode;
  roles: UserRole[] | "all";
}

const navItems: NavItem[] = [
  {
    label: "Browse Courses",
    to: "/courses",
    icon: <BookOpen className="size-4" />,
    roles: "all",
  },
  {
    label: "Dashboard",
    to: "/dashboard",
    icon: <LayoutDashboard className="size-4" />,
    roles: [UserRole.Student],
  },
  {
    label: "My Courses",
    to: "/instructor",
    icon: <GraduationCap className="size-4" />,
    roles: [UserRole.Instructor],
  },
  {
    label: "Analytics",
    to: "/instructor/analytics",
    icon: <ChartColumn className="size-4" />,
    roles: [UserRole.Instructor, UserRole.Admin],
  },
  {
    label: "Questions",
    to: "/instructor/questions",
    icon: <MessageSquare className="size-4" />,
    roles: [UserRole.Instructor, UserRole.Admin],
  },
  {
    label: "Refund Requests",
    to: "/admin/refunds",
    icon: <ReceiptText className="size-4" />,
    roles: [UserRole.Admin],
  },
  {
    label: "Manage Users",
    to: "/admin/users",
    icon: <Users className="size-4" />,
    roles: [UserRole.Admin],
  },
  {
    label: "Manage Courses",
    to: "/admin/courses",
    icon: <Shield className="size-4" />,
    roles: [UserRole.Admin],
  },
  {
    label: "Categories",
    to: "/admin/categories",
    icon: <Tag className="size-4" />,
    roles: [UserRole.Admin],
  },
];

function isVisible(item: NavItem, role: UserRole | null): boolean {
  if (item.roles === "all") return true;
  if (!role) return false;
  return item.roles.includes(role);
}

export function Sidebar({
  currentUser,
  recentCourses = [],
  isTeamAdmin = false,
  notificationFeed = { items: [], unreadCount: 0, nextCursor: null },
}: SidebarProps) {
  const currentUserRole = currentUser?.role ?? null;
  const [isDark, setIsDark] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const notificationBellRef = useRef<HTMLButtonElement>(null);
  const authoritativeUnreadCount = notificationFeed.unreadCount;
  const [unreadCount, setUnreadCount] = useState(authoritativeUnreadCount);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
  }, []);

  useEffect(() => {
    if (!feedOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [feedOpen]);

  const closeNotificationFeed = useCallback((returnFocus = true) => {
    setFeedOpen(false);
    if (returnFocus) {
      requestAnimationFrame(() => notificationBellRef.current?.focus());
    }
  }, []);

  function containNotificationFocus(
    event: React.KeyboardEvent<HTMLElement>
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeNotificationFeed();
      return;
    }
    if (event.key !== "Tab") return;

    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(
      (element) =>
        !element.hasAttribute("hidden") && element.getClientRects().length > 0
    );
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }

    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!controls.includes(document.activeElement as HTMLElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const applySynchronizedPage = useCallback(
    (page: { unreadCount: number }) => setUnreadCount(page.unreadCount),
    []
  );

  useEffect(() => {
    setUnreadCount(authoritativeUnreadCount);
  }, [authoritativeUnreadCount]);

  useEffect(() => {
    const updateUnreadCount = (event: Event) => {
      const count = (event as CustomEvent<unknown>).detail;
      if (typeof count === "number") setUnreadCount(count);
    };
    window.addEventListener(
      "cadence:notification-unread-count",
      updateUnreadCount
    );
    return () =>
      window.removeEventListener(
        "cadence:notification-unread-count",
        updateUnreadCount
      );
  }, []);

  function toggleDarkMode() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("cadence-theme", next ? "dark" : "light");
    } catch {}
  }

  return (
    <aside className="flex h-screen w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <NotificationSync
        personId={currentUser?.id ?? null}
        initialPage={notificationFeed}
        onPage={applySynchronizedPage}
      />
      <div className="relative flex h-14 items-center justify-between border-b border-sidebar-border px-4">
        <NavLink to="/" className="text-lg font-bold tracking-tight">
          Cadence
        </NavLink>
        {currentUser && (
          <button
            ref={notificationBellRef}
            type="button"
            aria-label={
              unreadCount > 0
                ? `Notification Feed, ${unreadCount} unread`
                : "Notification Feed"
            }
            aria-expanded={feedOpen}
            onClick={() =>
              setFeedOpen((open) => {
                if (!open) requestNotificationReconciliation();
                return !open;
              })
            }
            className="relative flex min-h-11 min-w-11 items-center justify-center rounded-md p-2 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Bell className="size-4" />
            {unreadCount > 0 && (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 size-2 rounded-full bg-primary"
              />
            )}
          </button>
        )}
        {feedOpen && currentUser && (
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Notification Feed"
            onKeyDown={containNotificationFocus}
            className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden border bg-popover p-4 text-popover-foreground shadow-lg sm:absolute sm:inset-auto sm:left-2 sm:top-12 sm:max-h-[calc(100vh-4rem)] sm:w-96 sm:max-w-[calc(100vw-1rem)] sm:rounded-md sm:p-3"
          >
            <button
              type="button"
              aria-label="Close Notification Feed"
              onClick={() => closeNotificationFeed()}
              className="absolute right-2 top-2 z-10 flex min-h-11 min-w-11 items-center justify-center rounded-md text-2xl leading-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span aria-hidden="true">&times;</span>
            </button>
            <div
              role="region"
              aria-label="Notification Feed"
              className="flex min-h-0 flex-1 flex-col"
            >
              <NotificationFeed
                initialPage={notificationFeed}
                onUnreadCountChange={setUnreadCount}
                onActivate={() => {
                  setUnreadCount((count) => Math.max(0, count - 1));
                  setFeedOpen(false);
                }}
                onReadFailure={() => setUnreadCount((count) => count + 1)}
                onOpenFull={() => closeNotificationFeed(false)}
              />
            </div>
          </section>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {navItems
          .filter((item) => isVisible(item, currentUserRole))
          .map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )
              }
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        {isTeamAdmin && (
          <NavLink
            to="/team"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )
            }
          >
            <UsersRound className="size-4" />
            Team
          </NavLink>
        )}
      </nav>

      {recentCourses.length > 0 && (
        <div className="border-t border-sidebar-border p-3">
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Recent Courses
          </div>
          <div className="space-y-1">
            {recentCourses.map((course) => (
              <NavLink
                key={course.courseId}
                to={`/courses/${course.slug}`}
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-3 py-2 transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )
                }
              >
                <div className="truncate text-sm font-medium">
                  {course.title}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-full bg-sidebar-accent">
                    <div
                      className="h-1.5 rounded-full bg-primary"
                      style={{ width: `${course.progress}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-xs text-sidebar-foreground/50">
                    {course.progress}%
                  </span>
                </div>
              </NavLink>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-sidebar-border p-3 space-y-1">
        <button
          onClick={toggleDarkMode}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {isDark ? "Light Mode" : "Dark Mode"}
        </button>

        {currentUser && (
          <div className="flex items-center gap-3 rounded-md px-3 py-2">
            <UserAvatar
              name={currentUser.name}
              avatarUrl={currentUser.avatarUrl}
            />
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium">
                {currentUser.name}
              </div>
              <div className="truncate text-xs capitalize text-sidebar-foreground/50">
                {currentUser.role}
              </div>
            </div>
            <NavLink
              to="/settings"
              title="Settings"
              className="rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Settings className="size-4" />
            </NavLink>
            <Form method="post" action="/api/logout">
              <button
                type="submit"
                title="Sign out"
                className="rounded-md p-1 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <LogOut className="size-4" />
              </button>
            </Form>
          </div>
        )}
      </div>
    </aside>
  );
}
