import { Form, data, isRouteErrorResponse, Link, redirect } from "react-router";
import { alias } from "drizzle-orm/sqlite-core";
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { db } from "~/db";
import {
  courses,
  purchases,
  refundRequests,
  RefundRequestStatus,
  UserRole,
  users,
} from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { formatPrice } from "~/lib/utils";
import { parseFormData } from "~/lib/validation";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  processRefundRequest,
  RefundRequestAlreadyResolvedError,
  RefundRequestNotFoundError,
} from "~/services/refundRequestService";

const refundDecisionSchema = z.object({
  refundRequestId: z.coerce.number().int().positive(),
  intent: z.enum([RefundRequestStatus.Approved, RefundRequestStatus.Declined]),
  resolutionNote: z
    .string()
    .trim()
    .min(5, "Enter an internal Resolution Note.")
    .max(1000, "Keep the Resolution Note under 1000 characters."),
});

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

function getRefundRequests() {
  const resolver = alias(users, "resolver");

  return db
    .select({
      id: refundRequests.id,
      status: refundRequests.status,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
      resolvedAt: refundRequests.resolvedAt,
      resolutionNote: refundRequests.resolutionNote,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      completedLessons: refundRequests.eligibilityCompletedLessons,
      totalLessons: refundRequests.eligibilityTotalLessons,
      watchedSeconds: refundRequests.eligibilityWatchedSeconds,
      redeemedSeats: refundRequests.eligibilityRedeemedSeats,
      resolverName: resolver.name,
      previousRequestCount: sql<number>`(
        select count(*) from refund_requests previous
        where previous.purchase_id = ${refundRequests.purchaseId}
          and previous.id < ${refundRequests.id}
      )`,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(resolver, eq(refundRequests.resolvedByUserId, resolver.id))
    .orderBy(
      sql`case when ${refundRequests.status} = 'open' then 0 else 1 end`,
      asc(refundRequests.requestedAt),
      desc(refundRequests.resolvedAt)
    )
    .all();
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review and resolve Refund Requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to review refunds.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can review Refund Requests.", { status: 403 });
  }

  return { refundRequests: getRefundRequests() };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("You must be logged in.", { status: 401 });
  }

  const currentUser = getUserById(currentUserId);
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can resolve Refund Requests.", { status: 403 });
  }

  const parsed = parseFormData(await request.formData(), refundDecisionSchema);
  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  try {
    processRefundRequest(db, {
      refundRequestId: parsed.data.refundRequestId,
      decision: parsed.data.intent,
      resolutionNote: parsed.data.resolutionNote,
      resolvedByUserId: currentUserId,
    });
  } catch (error) {
    if (error instanceof RefundRequestNotFoundError) {
      throw data(error.message, { status: 404 });
    }
    if (error instanceof RefundRequestAlreadyResolvedError) {
      throw data(error.message, { status: 409 });
    }
    throw error;
  }

  return redirect("/admin/refunds");
}

function Evidence({
  completedLessons,
  totalLessons,
  watchedSeconds,
  redeemedSeats,
}: {
  completedLessons: number;
  totalLessons: number;
  watchedSeconds: number;
  redeemedSeats: number;
}) {
  const completion =
    totalLessons === 0
      ? "No lessons"
      : `${completedLessons}/${totalLessons} lessons (${Math.round((completedLessons / totalLessons) * 100)}%)`;

  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-muted-foreground">Completion at request</dt>
        <dd>{completion}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Video usage at request</dt>
        <dd>{Math.floor(watchedSeconds / 60)} minutes</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Redeemed team seats</dt>
        <dd>{redeemedSeats}</dd>
      </div>
    </dl>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const openRequests = loaderData.refundRequests.filter(
    (request) => request.status === RefundRequestStatus.Open
  );
  const resolvedRequests = loaderData.refundRequests.filter(
    (request) => request.status !== RefundRequestStatus.Open
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
      <div>
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Review eligible requests from oldest to newest.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Open ({openRequests.length})</h2>
        {openRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No requests are waiting for review.
          </p>
        ) : (
          openRequests.map((refundRequest) => (
            <Card key={refundRequest.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">
                      {refundRequest.courseTitle}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {refundRequest.learnerName} · {refundRequest.learnerEmail}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-medium">
                      {formatPrice(refundRequest.amountPaid)}
                    </div>
                    <div className="text-muted-foreground">
                      Requested{" "}
                      {new Date(refundRequest.requestedAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <p className="text-sm text-muted-foreground">
                    Learner’s reason
                  </p>
                  <p>{refundRequest.reason}</p>
                </div>
                <Evidence
                  completedLessons={refundRequest.completedLessons}
                  totalLessons={refundRequest.totalLessons}
                  watchedSeconds={refundRequest.watchedSeconds}
                  redeemedSeats={refundRequest.redeemedSeats}
                />
                <p className="text-xs text-muted-foreground">
                  Purchased{" "}
                  {new Date(refundRequest.purchasedAt).toLocaleDateString()} ·
                  Previous requests for this purchase:{" "}
                  {refundRequest.previousRequestCount}
                </p>
                <Form method="post" className="space-y-3">
                  <input
                    type="hidden"
                    name="refundRequestId"
                    value={refundRequest.id}
                  />
                  <div className="space-y-2">
                    <Label htmlFor={`resolution-note-${refundRequest.id}`}>
                      Internal Resolution Note
                    </Label>
                    <Textarea
                      id={`resolution-note-${refundRequest.id}`}
                      name="resolutionNote"
                      minLength={5}
                      maxLength={1000}
                      required
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      name="intent"
                      value={RefundRequestStatus.Approved}
                      type="submit"
                    >
                      Approve
                    </Button>
                    <Button
                      name="intent"
                      value={RefundRequestStatus.Declined}
                      type="submit"
                      variant="outline"
                    >
                      Decline
                    </Button>
                  </div>
                </Form>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">
          Resolved ({resolvedRequests.length})
        </h2>
        {resolvedRequests.map((refundRequest) => (
          <Card key={refundRequest.id}>
            <CardContent className="space-y-2 pt-6">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <h3 className="font-medium">{refundRequest.courseTitle}</h3>
                  <p className="text-sm text-muted-foreground">
                    {refundRequest.learnerName} ·{" "}
                    {formatPrice(refundRequest.amountPaid)}
                  </p>
                </div>
                <span className="text-sm font-medium capitalize">
                  {refundRequest.status === RefundRequestStatus.Approved
                    ? "Approved — refund pending"
                    : "Declined"}
                </span>
              </div>
              <p className="text-sm">{refundRequest.resolutionNote}</p>
              <p className="text-xs text-muted-foreground">
                Resolved{" "}
                {refundRequest.resolvedAt
                  ? new Date(refundRequest.resolvedAt).toLocaleDateString()
                  : "—"}
                {refundRequest.resolverName
                  ? ` by ${refundRequest.resolverName}`
                  : ""}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? typeof error.data === "string"
      ? error.data
      : error.statusText
    : "An unexpected error occurred.";

  return (
    <div className="mx-auto max-w-xl p-8 text-center">
      <h1 className="text-2xl font-bold">Refund review unavailable</h1>
      <p className="mt-2 text-muted-foreground">{message}</p>
      <Link to="/">
        <Button className="mt-6">Go Home</Button>
      </Link>
    </div>
  );
}
