import { z } from "zod";
import {
  createNotificationOutcomeService,
  verifyKnockWebhookSignature,
} from "~/services/notificationOutcomeService.server";

const messageOutcomeSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "message.delivered",
    "message.undelivered",
    "message.not_sent",
    "message.bounced",
  ]),
  created_at: z.string().datetime({ offset: true }),
  data: z.object({
    id: z.string().min(1),
    updated_at: z.string().datetime({ offset: true }).optional(),
    source: z.object({ workflow_run_id: z.string().min(1) }),
  }),
});

type OutcomeRecorder = ReturnType<
  typeof createNotificationOutcomeService
>["recordOutcome"];

export function createNotificationOutcomeAction({
  secret,
  recordOutcome,
  now = () => new Date(),
}: {
  secret: string;
  recordOutcome: OutcomeRecorder;
  now?: () => Date;
}) {
  return async ({ request }: { request: Request }) => {
    const body = await request.text();
    if (
      !verifyKnockWebhookSignature(
        body,
        request.headers.get("x-knock-signature"),
        secret,
        now()
      )
    ) {
      throw new Response(null, { status: 401 });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Response(null, { status: 400 });
    }
    const parsed = messageOutcomeSchema.safeParse(json);
    if (!parsed.success) throw new Response(null, { status: 400 });
    const event = parsed.data;
    recordOutcome({
      providerEventId: event.id,
      workflowRunId: event.data.source.workflow_run_id,
      kind:
        event.type === "message.delivered" ? "delivered" : "permanently_failed",
      providerMessageIds: [event.data.id],
      occurredAt: event.data.updated_at ?? event.created_at,
    });
    return new Response(null, { status: 204 });
  };
}
