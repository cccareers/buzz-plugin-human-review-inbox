import type { MessageAction, Page, PluginModule, RelaySnapshot } from "@buzz/author";
import {
  listReviews,
  parseReceipt,
  parseRequest,
  receiptBody,
  requestBody,
  reviewDecisions,
  type Decision,
  type ReviewRequest,
} from "./review-records";

export const inject = ["react", "conversation", "pages", "relay", "navigation"];

type Session = RelaySnapshot["session"];
type Outgoing = ReturnType<NonNullable<Session["outbox"]>["snapshot"]>[number];
const noOutgoing: readonly Outgoing[] = [];
const noSubscription = () => () => {};
const emptyOutbox = () => noOutgoing;
const eventId = /^[0-9a-f]{64}$/;
const channelId = /^[A-Za-z0-9_-]{1,128}$/;
const button = { className: "buzz-button", "data-buzz-ui": "", "data-size": "sm" } as const;
const row = { display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" } as const;
const field = { display: "grid", gap: "var(--space-1)" } as const;

function writableChannel(session: Session, id: string) {
  const channel = session.channels.get?.(id) ?? session.channels.list().channels.find((item) => item.id === id);
  return channel && session.viewer && channel.members?.includes(session.viewer) &&
    !channel.cached && !channel.readOnly && !channel.pending && !channel.archived &&
    session.outbox?.supports(9) ? channel : undefined;
}

function describeDelivery(item: Outgoing) {
  switch (item.delivery) {
    case "sending": return "Sending…";
    case "accepted":
    case "seen": return "Accepted by the relay.";
    case "failed": return "Delivery failed. Check the Buzz outbox.";
    case "unknown": return "Delivery is unconfirmed. Check the Buzz outbox.";
  }
}

function pendingReceipt(items: readonly Outgoing[], request: ReviewRequest) {
  return items.find(({ event }) => parseReceipt(event, request));
}

function isReviewerRole(role: string | undefined) {
  return role === "owner" || role === "admin" || role === "member";
}

export const apply: PluginModule["apply"] = (ctx) => {
  const React = ctx.react;
  const { useEffect, useId, useRef, useState, useSyncExternalStore } = React;

  function useOutbox(session: Session) {
    return useSyncExternalStore(session.outbox?.subscribe ?? noSubscription, session.outbox?.snapshot ?? emptyOutbox);
  }

  function current(session: Session) {
    const connection = ctx.relay.snapshot();
    return connection.status === "ready" && !connection.cached && connection.session === session;
  }

  const RequestDialog: MessageAction["component"] = ({ message, session, close }) => {
    const dialog = useRef<HTMLDialogElement>(null);
    const heading = useId();
    const [reviewer, setReviewer] = useState("");
    const [note, setNote] = useState("");
    const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
    const [error, setError] = useState("");
    const [posted, setPosted] = useState<string>();
    const [accepted, setAccepted] = useState(false);
    const posting = useRef(false);
    const connection = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    useSyncExternalStore(session.channels.subscribeList, session.channels.list);
    useSyncExternalStore(session.names.subscribe, session.names.snapshot);
    const choices = useSyncExternalStore(session.agentChoices.subscribe, session.agentChoices.snapshot);
    const profiles = useSyncExternalStore(session.profiles.subscribe, session.profiles.snapshot);
    const memberAdmin = useSyncExternalStore(session.memberAdministration.subscribe,
      () => session.memberAdministration.snapshot(message.channelId));
    const outbox = useOutbox(session);
    const members = writableChannel(session, message.channelId)?.members;
    const memberKeys = members?.join(",") ?? "";
    const operation = outbox.find(({ event }) => event.id === posted);
    const delivery = operation?.delivery;

    useEffect(() => {
      const element = dialog.current;
      if (!element) return;
      const focused = document.activeElement;
      element.showModal();
      return () => {
        element.close();
        if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
      };
    }, []);

    useEffect(() => {
      let active = true;
      session.agentChoices.ensure();
      setLoad("loading");
      void Promise.all([
        session.profiles.ensure(memberKeys ? memberKeys.split(",") : []),
        session.memberAdministration.refresh(message.channelId),
      ]).then(() => {
        if (!active) return;
        setLoad(session.memberAdministration.snapshot(message.channelId).status === "ready" ? "ready" : "error");
      }, () => { if (active) setLoad("error"); });
      return () => { active = false; };
    }, [session, message.channelId, memberKeys]);

    useEffect(() => {
      if (!posted || !session.viewer) return;
      if (delivery === "accepted" || delivery === "seen") {
        setAccepted(true);
        return;
      }
      if (delivery || !current(session)) return;
      const controller = new AbortController();
      void session.readRemote([{
        kinds: [9], ids: [posted], "#h": [message.channelId], consistency: "strong", limit: 1,
      }], { signal: controller.signal }).then((events) => {
        if (!controller.signal.aborted && events.some((event) => event.id === posted)) setAccepted(true);
      }, () => {});
      return () => controller.abort();
    }, [session, message.channelId, posted, delivery, connection]);

    const roles = memberAdmin.authority.roles;
    const knownAgents = new Set(choices.identities.map(({ pubkey }) => pubkey));
    const named = session.names.scope(members);
    const candidates = (members ?? []).flatMap((key) => {
      if (key === session.viewer || knownAgents.has(key) || profiles.get(key)?.isAgent ||
        !isReviewerRole(roles[key])) return [];
      const name = named(key);
      return name ? [{ key, label: [name.name, name.qualifier].filter(Boolean).join(" · ") }] : [];
    }).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    const selected = candidates.find(({ key }) => key === reviewer);
    const canSend = load === "ready" && memberAdmin.status === "ready" && current(session) && !!selected;

    return (
      <dialog ref={dialog} aria-labelledby={heading} onCancel={(event) => { event.preventDefault(); close(); }}
        style={{
          width: "min(30rem, calc(100vw - 2rem))", margin: "auto", boxSizing: "border-box",
          padding: "var(--space-panel-inset)", border: "1px solid var(--border-standard)",
          borderRadius: "var(--radius-panel, 0.75rem)", background: "var(--surface-panel)",
          color: "var(--text-standard)",
        }}>
        <form style={{ display: "grid", gap: "var(--space-3)" }} onSubmit={(event) => {
          event.preventDefault();
          if (!event.currentTarget.isConnected || posting.current || !selected || !canSend || !current(session)) return;
          if (!writableChannel(session, message.channelId)?.members?.includes(reviewer) ||
            session.agentChoices.snapshot().identities.some(({ pubkey }) => pubkey === reviewer) ||
            session.profiles.snapshot().get(reviewer)?.isAgent ||
            !isReviewerRole(session.memberAdministration.snapshot(message.channelId).authority.roles[reviewer])) {
            setError("This reviewer is no longer eligible. Reopen the request and choose a reviewer.");
            return;
          }
          posting.current = true;
          setError("");
          try {
            const body = requestBody({ channel: message.channelId, source: message.id, note,
              ...(message.threadRootId ? { thread: message.threadRootId } : {}),
            }, selected.label);
            setPosted(session.messages.send(message.channelId, body, [reviewer]));
          } catch (failure) {
            posting.current = false;
            setError(failure instanceof Error ? failure.message : "Buzz could not queue this request.");
          }
        }}>
          <h2 id={heading} className="text-label" style={{ margin: 0 }}>Request human review</h2>
          <p className="text-body-sm text-subtle" style={{ margin: 0 }}>The request and decision will appear in this channel.</p>
          {load === "loading" && <p role="status">Loading channel members…</p>}
          {load === "error" && <p role="alert">Buzz could not verify the channel’s members and roles.</p>}
          {load === "ready" && !candidates.length && <p role="status">There are no named reviewers with posting access in this channel.</p>}
          {!current(session) && <p role="status">Reconnect to send a request.</p>}
          <label className="text-label-sm" style={field}>
            Reviewer
            <select className="buzz-input" data-buzz-ui="" value={reviewer} disabled={!!posted || load !== "ready"} required
              onChange={(event) => setReviewer(event.currentTarget.value)}>
              <option value="">Choose a channel member</option>
              {candidates.map(({ key, label }) => <option value={key} key={key}>{label} ({key.slice(0, 8)})</option>)}
            </select>
          </label>
          <label className="text-label-sm" style={field}>
            Note (optional)
            <textarea className="buzz-textarea" data-buzz-ui="" data-surface="inset" rows={3} value={note} maxLength={2000}
              disabled={!!posted} onChange={(event) => setNote(event.currentTarget.value)} />
          </label>
          {error && <p role="alert">{error}</p>}
          {posted && <p role="status">{accepted ? "Review request sent." : operation ? describeDelivery(operation) : "Request queued. Delivery hasn’t been confirmed."}</p>}
          <div style={{ ...row, justifyContent: "flex-end" }}>
            <button {...button} type="button" data-variant="subtle" onClick={close}>{posted ? "Close" : "Cancel"}</button>
            {!posted && <button {...button} type="submit" data-variant="prominent" disabled={!canSend}>Send request</button>}
          </div>
        </form>
      </dialog>
    );
  };

  function Reviews({ connection, viewer }: { connection: RelaySnapshot; viewer: string }) {
    const { session } = connection;
    const outbox = useOutbox(session);
    const channels = useSyncExternalStore(session.channels.subscribeList, session.channels.list);
    useSyncExternalStore(session.names.subscribe, session.names.snapshot);
    const [data, setData] = useState<Awaited<ReturnType<typeof listReviews>>>();
    const [revision, refresh] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [working, setWorking] = useState<string>();
    const inFlight = useRef<AbortController | undefined>(undefined);
    const [queued, setQueued] = useState<Record<string, string>>({});
    const deliveryKey = Object.entries(queued).map(([id, eventId]) =>
      `${id}:${outbox.find(({ event }) => event.id === eventId)?.delivery ?? "settled"}`,
    ).join("|");

    useEffect(() => () => inFlight.current?.abort(), []);
    useEffect(() => {
      const controller = new AbortController();
      setLoading(true);
      setError("");
      void listReviews(session, viewer, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setLoading(false);
        void session.profiles.ensure(result.requests.map(({ author }) => author)).catch(() => {});
      }, () => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError("Couldn’t load current review requests. Refresh to try again.");
      });
      return () => controller.abort();
    }, [session, viewer, revision, deliveryKey]);

    async function decide(request: ReviewRequest, decision: Decision) {
      const channel = writableChannel(session, request.channel);
      if (inFlight.current || !current(session) || !channel || channel.viewerRole === "bot" ||
        pendingReceipt(session.outbox?.snapshot() ?? noOutgoing, request)) return;
      const controller = new AbortController();
      inFlight.current = controller;
      setWorking(request.id);
      setError("");
      try {
        const [requestEvents, replies] = await Promise.all([
          session.readRemote([{ kinds: [9], ids: [request.id], "#h": [request.channel], consistency: "strong", limit: 1 }], { signal: controller.signal }),
          session.readRemote([{ kinds: [9], authors: [viewer], "#e": [request.id], "#h": [request.channel], consistency: "strong", limit: 100 }], { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || !current(session)) return;
        if (!requestEvents.some((event) => event.id === request.id && parseRequest(event, viewer))) {
          throw new Error("This request is no longer available.");
        }
        if (replies.some((event) => parseReceipt(event, request))) {
          refresh((value) => value + 1);
          return;
        }
        const box = session.outbox;
        const destination = writableChannel(session, request.channel);
        if (!box || !destination || destination.viewerRole === "bot") throw new Error("You can no longer reply in this channel.");
        if (pendingReceipt(box.snapshot(), request)) return;
        // A direct reply without mention tags records the decision in the channel.
        const id = box.send({ kind: 9, tags: [["h", request.channel], ["e", request.id, "", "reply"]], content: receiptBody(request, decision) });
        setQueued((previous) => ({ ...previous, [request.id]: id }));
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Couldn’t record the decision.");
      } finally {
        inFlight.current = undefined;
        if (!controller.signal.aborted) setWorking(undefined);
      }
    }

    async function openSource(request: ReviewRequest) {
      if (!connection.origin || !current(session)) return;
      const result = await ctx.navigation.open({
        kind: "conversation", version: 1, scope: { viewer, communityOrigin: connection.origin },
        channelId: request.channel, messageId: request.source,
        ...(request.thread ? { threadRootId: request.thread } : {}),
      });
      if (result.status === "failed") setError("Buzz couldn’t open the source message.");
    }

    const available = data?.requests.filter(({ channel }) => channels.channels.some((item) =>
      item.id === channel && !item.cached && item.members?.includes(viewer),
    ));
    return (
      <>
        <div style={{ ...row, justifyContent: "space-between" }}>
          <h1 className="text-title" style={{ margin: 0 }}>Human Review Inbox</h1>
          <button {...button} type="button" data-variant="subtle" disabled={loading || !!working} onClick={() => {
            setQueued((previous) => Object.fromEntries(Object.entries(previous).filter(([, id]) => outbox.some(({ event }) => event.id === id))));
            refresh((value) => value + 1);
          }}>Refresh</button>
        </div>
        {loading && <p role="status">Loading review requests…</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && !error && !available?.length && <p>No recent review requests addressed to you.</p>}
        {!!available?.length && <ul style={{ display: "grid", gap: "var(--space-3)", listStyle: "none", padding: 0, margin: 0 }}>
          {available.map((request) => {
            const receipt = data?.receipts.get(request.id);
            const operation = pendingReceipt(outbox, request);
            const channel = channels.channels.find(({ id }) => id === request.channel);
            const author = session.names.resolve(request.author, request.author.slice(0, 12));
            const canDecide = !!writableChannel(session, request.channel) && channel?.viewerRole !== "bot";
            return (
              <li key={request.id} style={{
                display: "grid", gap: "var(--space-2)", padding: "var(--space-3)", minWidth: 0,
                border: "1px solid var(--border-standard)", borderRadius: "var(--radius-panel, 0.75rem)", overflowWrap: "anywhere",
              }}>
                <div className="text-label">{author} · #{channel?.name ?? request.channel}</div>
                <time className="text-body-sm text-subtle" dateTime={new Date(request.createdAt * 1000).toISOString()}>
                  {new Date(request.createdAt * 1000).toLocaleString()}
                </time>
                {request.note && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{request.note}</p>}
                <div style={row}>
                  <button {...button} type="button" data-variant="subtle" onClick={() => void openSource(request)}>Open source</button>
                  {!receipt && !operation && !queued[request.id] && canDecide && reviewDecisions.map((decision) => (
                    <button {...button} key={decision} type="button" data-variant={decision === "Approve" ? "prominent" : "subtle"}
                      disabled={loading || !!working} onClick={() => void decide(request, decision)}>{decision}</button>
                  ))}
                </div>
                {receipt ? <p className="text-body-sm" style={{ margin: 0 }}>Recorded decision: {receipt.decision}</p>
                  : operation ? <p role="status" style={{ margin: 0 }}>{describeDelivery(operation)}</p>
                  : queued[request.id] ? <p role="status" style={{ margin: 0 }}>Decision queued. Refresh to confirm delivery.</p>
                  : !canDecide ? <p className="text-body-sm text-subtle" style={{ margin: 0 }}>You don’t have access to reply in this channel.</p>
                  : null}
              </li>
            );
          })}
        </ul>}
      </>
    );
  }

  const ReviewPage: Page["component"] = () => {
    const connection = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    return (
      <section style={{ display: "grid", gap: "var(--space-3)", padding: "var(--space-panel-inset)", maxWidth: "48rem" }}>
        {connection.status === "ready" && !connection.cached && connection.viewer
          ? <Reviews key={connection.generation} connection={connection} viewer={connection.viewer} />
          : <><h1 className="text-title" style={{ margin: 0 }}>Human Review Inbox</h1><p role="status">Connect to your Buzz community to see review requests.</p></>}
      </section>
    );
  };

  ctx.pages.register({ id: "reviews", title: "Human Review Inbox", primary: true, component: ReviewPage });
  ctx.conversation.registerMessageAction({
    id: "request-human-review", title: "Request human review", component: RequestDialog,
    matches(message, session) {
      return !!(eventId.test(message.id) && channelId.test(message.channelId) &&
        (!message.threadRootId || eventId.test(message.threadRootId)) &&
        (!message.delivery || message.delivery === "accepted" || message.delivery === "seen") &&
        !message.membership && !message.huddle && !message.audience && !message.notice &&
        writableChannel(session, message.channelId));
    },
  });
};
