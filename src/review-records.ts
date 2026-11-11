import type { RelaySnapshot } from "@buzz/author";

type Session = RelaySnapshot["session"];
type Event = Pick<Awaited<ReturnType<Session["readRemote"]>>[number], "id" | "pubkey" | "created_at" | "kind" | "content" | "tags">;

const eventId = /^[0-9a-f]{64}$/;
const channelId = /^[A-Za-z0-9_-]{1,128}$/;
const requestHeading = "**Human review requested**";
const decisionHeading = "**Human review decision**";
const decisions = ["Approve", "Request changes", "Decline"] as const;

export type Decision = (typeof decisions)[number];
export const reviewDecisions: readonly Decision[] = decisions;

export interface ReviewRequest {
  id: string;
  channel: string;
  author: string;
  reviewer: string;
  source: string;
  thread?: string;
  note: string;
  createdAt: number;
}

export interface Receipt {
  id: string;
  requestId: string;
  decision: Decision;
  createdAt: number;
}

function channelOf(event: Event): string | undefined {
  const tags = event.tags.filter(([name]) => name === "h");
  return tags.length === 1 ? tags[0]?.[1] : undefined;
}

export function messageUrl(channel: string, id: string, thread?: string) {
  const params = new URLSearchParams({ channel, id });
  if (thread) params.set("thread", thread);
  return `buzz://message?${params}`;
}

export function requestBody(
  request: Pick<ReviewRequest, "channel" | "source" | "thread" | "note">,
  reviewerName: string,
) {
  const reviewer = reviewerName.replace(/[^\p{L}\p{N} ._@-]/gu, "").slice(0, 100);
  return [
    requestHeading,
    `Reviewer: ${reviewer || "named channel member"}`,
    `Source: ${messageUrl(request.channel, request.source, request.thread)}`,
    "",
    request.note.trim(),
  ].join("\n");
}

export function parseRequest(event: Event, reviewer: string): ReviewRequest | undefined {
  const channel = channelOf(event);
  const recipients = event.tags.filter(([name]) => name === "p");
  if (
    !channel || !channelId.test(channel) ||
    event.kind !== 9 ||
    !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > 8_640_000_000_000 ||
    recipients.length !== 1 ||
    recipients[0]?.[1] !== reviewer ||
    event.tags.some(([name, , , marker]) => name === "e" && (marker === "reply" || marker === "root"))
  ) return;

  const [heading, reviewerLine, sourceLine, separator, ...note] = event.content.split("\n");
  if (
    heading !== requestHeading ||
    !reviewerLine?.startsWith("Reviewer: ") ||
    !sourceLine?.startsWith("Source: buzz://message?") ||
    (separator !== undefined && separator !== "")
  ) return;

  const params = new URLSearchParams(sourceLine.slice("Source: buzz://message?".length));
  const source = params.get("id") ?? "";
  const thread = params.get("thread") ?? undefined;
  if (
    params.get("channel") !== channel ||
    !eventId.test(source) ||
    (thread && !eventId.test(thread)) ||
    sourceLine !== `Source: ${messageUrl(channel, source, thread)}`
  ) return;

  return {
    id: event.id,
    channel,
    author: event.pubkey,
    reviewer,
    source,
    ...(thread ? { thread } : {}),
    note: note.join("\n").slice(0, 2000),
    createdAt: event.created_at,
  };
}

export function receiptBody(request: ReviewRequest, decision: Decision) {
  return [
    decisionHeading,
    `Decision: ${decision}`,
    `Request: ${messageUrl(request.channel, request.id)}`,
  ].join("\n");
}

export function parseReceipt(event: Event, request: ReviewRequest): Receipt | undefined {
  const threadTags = event.tags.filter(
    ([name, , , marker]) => name === "e" && (marker === "reply" || marker === "root"),
  );
  if (
    event.kind !== 9 ||
    event.pubkey !== request.reviewer ||
    channelOf(event) !== request.channel ||
    threadTags.length !== 1 ||
    threadTags[0]?.[1] !== request.id ||
    threadTags[0]?.[3] !== "reply"
  ) return;

  const decision = decisions.find((choice) => event.content === receiptBody(request, choice));
  return decision && {
    id: event.id,
    requestId: request.id,
    decision,
    createdAt: event.created_at,
  };
}

export async function listReviews(session: Session, viewer: string, signal: AbortSignal) {
  const addressed = await session.readRemote(
    [{ kinds: [9], "#p": [viewer], limit: 100 }],
    { signal },
  );
  const requests = addressed
    .map((event) => parseRequest(event, viewer))
    .filter((request): request is ReviewRequest => request !== undefined)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .slice(0, 25);
  const events = requests.length
    ? await session.readRemote([{
      kinds: [9],
      authors: [viewer],
      "#e": requests.map(({ id }) => id),
      "#h": [...new Set(requests.map(({ channel }) => channel))],
      consistency: "strong",
      limit: 100,
    }], { signal })
    : [];
  const receipts = new Map<string, Receipt>();
  for (const event of [...events].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
    for (const request of requests) {
      if (receipts.has(request.id)) continue;
      const receipt = parseReceipt(event, request);
      if (receipt) receipts.set(request.id, receipt);
    }
  }
  return { requests, receipts };
}
