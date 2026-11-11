// src/review-records.ts
var eventId = /^[0-9a-f]{64}$/;
var channelId = /^[A-Za-z0-9_-]{1,128}$/;
var requestHeading = "**Human review requested**";
var decisionHeading = "**Human review decision**";
var decisions = ["Approve", "Request changes", "Decline"];
var reviewDecisions = decisions;
function channelOf(event) {
  const tags = event.tags.filter(([name]) => name === "h");
  return tags.length === 1 ? tags[0]?.[1] : void 0;
}
function messageUrl(channel, id, thread) {
  const params = new URLSearchParams({ channel, id });
  if (thread) params.set("thread", thread);
  return `buzz://message?${params}`;
}
function requestBody(request, reviewerName) {
  const reviewer = reviewerName.replace(/[^\p{L}\p{N} ._@-]/gu, "").slice(0, 100);
  return [
    requestHeading,
    `Reviewer: ${reviewer || "named channel member"}`,
    `Source: ${messageUrl(request.channel, request.source, request.thread)}`,
    "",
    request.note.trim()
  ].join("\n");
}
function parseRequest(event, reviewer) {
  const channel = channelOf(event);
  const recipients = event.tags.filter(([name]) => name === "p");
  if (!channel || !channelId.test(channel) || event.kind !== 9 || !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > 864e10 || recipients.length !== 1 || recipients[0]?.[1] !== reviewer || event.tags.some(([name, , , marker]) => name === "e" && (marker === "reply" || marker === "root"))) return;
  const [heading, reviewerLine, sourceLine, separator, ...note] = event.content.split("\n");
  if (heading !== requestHeading || !reviewerLine?.startsWith("Reviewer: ") || !sourceLine?.startsWith("Source: buzz://message?") || separator !== void 0 && separator !== "") return;
  const params = new URLSearchParams(sourceLine.slice("Source: buzz://message?".length));
  const source = params.get("id") ?? "";
  const thread = params.get("thread") ?? void 0;
  if (params.get("channel") !== channel || !eventId.test(source) || thread && !eventId.test(thread) || sourceLine !== `Source: ${messageUrl(channel, source, thread)}`) return;
  return {
    id: event.id,
    channel,
    author: event.pubkey,
    reviewer,
    source,
    ...thread ? { thread } : {},
    note: note.join("\n").slice(0, 2e3),
    createdAt: event.created_at
  };
}
function receiptBody(request, decision) {
  return [
    decisionHeading,
    `Decision: ${decision}`,
    `Request: ${messageUrl(request.channel, request.id)}`
  ].join("\n");
}
function parseReceipt(event, request) {
  const threadTags = event.tags.filter(
    ([name, , , marker]) => name === "e" && (marker === "reply" || marker === "root")
  );
  if (event.kind !== 9 || event.pubkey !== request.reviewer || channelOf(event) !== request.channel || threadTags.length !== 1 || threadTags[0]?.[1] !== request.id || threadTags[0]?.[3] !== "reply") return;
  const decision = decisions.find((choice) => event.content === receiptBody(request, choice));
  return decision && {
    id: event.id,
    requestId: request.id,
    decision,
    createdAt: event.created_at
  };
}
async function listReviews(session, viewer, signal) {
  const addressed = await session.readRemote(
    [{ kinds: [9], "#p": [viewer], limit: 100 }],
    { signal }
  );
  const requests = addressed.map((event) => parseRequest(event, viewer)).filter((request) => request !== void 0).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, 25);
  const events = requests.length ? await session.readRemote([{
    kinds: [9],
    authors: [viewer],
    "#e": requests.map(({ id }) => id),
    "#h": [...new Set(requests.map(({ channel }) => channel))],
    consistency: "strong",
    limit: 100
  }], { signal }) : [];
  const receipts = /* @__PURE__ */ new Map();
  for (const event of [...events].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))) {
    for (const request of requests) {
      if (receipts.has(request.id)) continue;
      const receipt = parseReceipt(event, request);
      if (receipt) receipts.set(request.id, receipt);
    }
  }
  return { requests, receipts };
}

// src/plugin.tsx
var inject = ["react", "conversation", "pages", "relay", "navigation"];
var noOutgoing = [];
var noSubscription = () => () => {
};
var emptyOutbox = () => noOutgoing;
var eventId2 = /^[0-9a-f]{64}$/;
var channelId2 = /^[A-Za-z0-9_-]{1,128}$/;
var button = { className: "buzz-button", "data-buzz-ui": "", "data-size": "sm" };
var row = { display: "flex", gap: "var(--space-2)", flexWrap: "wrap", alignItems: "center" };
var field = { display: "grid", gap: "var(--space-1)" };
function writableChannel(session, id) {
  const channel = session.channels.get?.(id) ?? session.channels.list().channels.find((item) => item.id === id);
  return channel && session.viewer && channel.members?.includes(session.viewer) && !channel.cached && !channel.readOnly && !channel.pending && !channel.archived && session.outbox?.supports(9) ? channel : void 0;
}
function describeDelivery(item) {
  switch (item.delivery) {
    case "sending":
      return "Sending\u2026";
    case "accepted":
    case "seen":
      return "Accepted by the relay.";
    case "failed":
      return "Delivery failed. Check the Buzz outbox.";
    case "unknown":
      return "Delivery is unconfirmed. Check the Buzz outbox.";
  }
}
function pendingReceipt(items, request) {
  return items.find(({ event }) => parseReceipt(event, request));
}
function isReviewerRole(role) {
  return role === "owner" || role === "admin" || role === "member";
}
var apply = (ctx) => {
  const React = ctx.react;
  const { useEffect, useId, useRef, useState, useSyncExternalStore } = React;
  function useOutbox(session) {
    return useSyncExternalStore(session.outbox?.subscribe ?? noSubscription, session.outbox?.snapshot ?? emptyOutbox);
  }
  function current(session) {
    const connection = ctx.relay.snapshot();
    return connection.status === "ready" && !connection.cached && connection.session === session;
  }
  const RequestDialog = ({ message, session, close }) => {
    const dialog = useRef(null);
    const heading = useId();
    const [reviewer, setReviewer] = useState("");
    const [note, setNote] = useState("");
    const [load, setLoad] = useState("loading");
    const [error, setError] = useState("");
    const [posted, setPosted] = useState();
    const [accepted, setAccepted] = useState(false);
    const posting = useRef(false);
    const connection = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    useSyncExternalStore(session.channels.subscribeList, session.channels.list);
    useSyncExternalStore(session.names.subscribe, session.names.snapshot);
    const choices = useSyncExternalStore(session.agentChoices.subscribe, session.agentChoices.snapshot);
    const profiles = useSyncExternalStore(session.profiles.subscribe, session.profiles.snapshot);
    const memberAdmin = useSyncExternalStore(
      session.memberAdministration.subscribe,
      () => session.memberAdministration.snapshot(message.channelId)
    );
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
        session.memberAdministration.refresh(message.channelId)
      ]).then(() => {
        if (!active) return;
        setLoad(session.memberAdministration.snapshot(message.channelId).status === "ready" ? "ready" : "error");
      }, () => {
        if (active) setLoad("error");
      });
      return () => {
        active = false;
      };
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
        kinds: [9],
        ids: [posted],
        "#h": [message.channelId],
        consistency: "strong",
        limit: 1
      }], { signal: controller.signal }).then((events) => {
        if (!controller.signal.aborted && events.some((event) => event.id === posted)) setAccepted(true);
      }, () => {
      });
      return () => controller.abort();
    }, [session, message.channelId, posted, delivery, connection]);
    const roles = memberAdmin.authority.roles;
    const knownAgents = new Set(choices.identities.map(({ pubkey }) => pubkey));
    const named = session.names.scope(members);
    const candidates = (members ?? []).flatMap((key) => {
      if (key === session.viewer || knownAgents.has(key) || profiles.get(key)?.isAgent || !isReviewerRole(roles[key])) return [];
      const name = named(key);
      return name ? [{ key, label: [name.name, name.qualifier].filter(Boolean).join(" \xB7 ") }] : [];
    }).sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    const selected = candidates.find(({ key }) => key === reviewer);
    const canSend = load === "ready" && memberAdmin.status === "ready" && current(session) && !!selected;
    return /* @__PURE__ */ React.createElement(
      "dialog",
      {
        ref: dialog,
        "aria-labelledby": heading,
        onCancel: (event) => {
          event.preventDefault();
          close();
        },
        style: {
          width: "min(30rem, calc(100vw - 2rem))",
          margin: "auto",
          boxSizing: "border-box",
          padding: "var(--space-panel-inset)",
          border: "1px solid var(--border-standard)",
          borderRadius: "var(--radius-panel, 0.75rem)",
          background: "var(--surface-panel)",
          color: "var(--text-standard)"
        }
      },
      /* @__PURE__ */ React.createElement("form", { style: { display: "grid", gap: "var(--space-3)" }, onSubmit: (event) => {
        event.preventDefault();
        if (!event.currentTarget.isConnected || posting.current || !selected || !canSend || !current(session)) return;
        if (!writableChannel(session, message.channelId)?.members?.includes(reviewer) || session.agentChoices.snapshot().identities.some(({ pubkey }) => pubkey === reviewer) || session.profiles.snapshot().get(reviewer)?.isAgent || !isReviewerRole(session.memberAdministration.snapshot(message.channelId).authority.roles[reviewer])) {
          setError("This reviewer is no longer eligible. Reopen the request and choose a reviewer.");
          return;
        }
        posting.current = true;
        setError("");
        try {
          const body = requestBody({
            channel: message.channelId,
            source: message.id,
            note,
            ...message.threadRootId ? { thread: message.threadRootId } : {}
          }, selected.label);
          setPosted(session.messages.send(message.channelId, body, [reviewer]));
        } catch (failure) {
          posting.current = false;
          setError(failure instanceof Error ? failure.message : "Buzz could not queue this request.");
        }
      } }, /* @__PURE__ */ React.createElement("h2", { id: heading, className: "text-label", style: { margin: 0 } }, "Request human review"), /* @__PURE__ */ React.createElement("p", { className: "text-body-sm text-subtle", style: { margin: 0 } }, "The request and decision will appear in this channel."), load === "loading" && /* @__PURE__ */ React.createElement("p", { role: "status" }, "Loading channel members\u2026"), load === "error" && /* @__PURE__ */ React.createElement("p", { role: "alert" }, "Buzz could not verify the channel\u2019s members and roles."), load === "ready" && !candidates.length && /* @__PURE__ */ React.createElement("p", { role: "status" }, "There are no named reviewers with posting access in this channel."), !current(session) && /* @__PURE__ */ React.createElement("p", { role: "status" }, "Reconnect to send a request."), /* @__PURE__ */ React.createElement("label", { className: "text-label-sm", style: field }, "Reviewer", /* @__PURE__ */ React.createElement(
        "select",
        {
          className: "buzz-input",
          "data-buzz-ui": "",
          value: reviewer,
          disabled: !!posted || load !== "ready",
          required: true,
          onChange: (event) => setReviewer(event.currentTarget.value)
        },
        /* @__PURE__ */ React.createElement("option", { value: "" }, "Choose a channel member"),
        candidates.map(({ key, label }) => /* @__PURE__ */ React.createElement("option", { value: key, key }, label, " (", key.slice(0, 8), ")"))
      )), /* @__PURE__ */ React.createElement("label", { className: "text-label-sm", style: field }, "Note (optional)", /* @__PURE__ */ React.createElement(
        "textarea",
        {
          className: "buzz-textarea",
          "data-buzz-ui": "",
          "data-surface": "inset",
          rows: 3,
          value: note,
          maxLength: 2e3,
          disabled: !!posted,
          onChange: (event) => setNote(event.currentTarget.value)
        }
      )), error && /* @__PURE__ */ React.createElement("p", { role: "alert" }, error), posted && /* @__PURE__ */ React.createElement("p", { role: "status" }, accepted ? "Review request sent." : operation ? describeDelivery(operation) : "Request queued. Delivery hasn\u2019t been confirmed."), /* @__PURE__ */ React.createElement("div", { style: { ...row, justifyContent: "flex-end" } }, /* @__PURE__ */ React.createElement("button", { ...button, type: "button", "data-variant": "subtle", onClick: close }, posted ? "Close" : "Cancel"), !posted && /* @__PURE__ */ React.createElement("button", { ...button, type: "submit", "data-variant": "prominent", disabled: !canSend }, "Send request")))
    );
  };
  function Reviews({ connection, viewer }) {
    const { session } = connection;
    const outbox = useOutbox(session);
    const channels = useSyncExternalStore(session.channels.subscribeList, session.channels.list);
    useSyncExternalStore(session.names.subscribe, session.names.snapshot);
    const [data, setData] = useState();
    const [revision, refresh] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [working, setWorking] = useState();
    const inFlight = useRef(void 0);
    const [queued, setQueued] = useState({});
    const deliveryKey = Object.entries(queued).map(
      ([id, eventId3]) => `${id}:${outbox.find(({ event }) => event.id === eventId3)?.delivery ?? "settled"}`
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
        void session.profiles.ensure(result.requests.map(({ author }) => author)).catch(() => {
        });
      }, () => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setError("Couldn\u2019t load current review requests. Refresh to try again.");
      });
      return () => controller.abort();
    }, [session, viewer, revision, deliveryKey]);
    async function decide(request, decision) {
      const channel = writableChannel(session, request.channel);
      if (inFlight.current || !current(session) || !channel || channel.viewerRole === "bot" || pendingReceipt(session.outbox?.snapshot() ?? noOutgoing, request)) return;
      const controller = new AbortController();
      inFlight.current = controller;
      setWorking(request.id);
      setError("");
      try {
        const [requestEvents, replies] = await Promise.all([
          session.readRemote([{ kinds: [9], ids: [request.id], "#h": [request.channel], consistency: "strong", limit: 1 }], { signal: controller.signal }),
          session.readRemote([{ kinds: [9], authors: [viewer], "#e": [request.id], "#h": [request.channel], consistency: "strong", limit: 100 }], { signal: controller.signal })
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
        const id = box.send({ kind: 9, tags: [["h", request.channel], ["e", request.id, "", "reply"]], content: receiptBody(request, decision) });
        setQueued((previous) => ({ ...previous, [request.id]: id }));
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Couldn\u2019t record the decision.");
      } finally {
        inFlight.current = void 0;
        if (!controller.signal.aborted) setWorking(void 0);
      }
    }
    async function openSource(request) {
      if (!connection.origin || !current(session)) return;
      const result = await ctx.navigation.open({
        kind: "conversation",
        version: 1,
        scope: { viewer, communityOrigin: connection.origin },
        channelId: request.channel,
        messageId: request.source,
        ...request.thread ? { threadRootId: request.thread } : {}
      });
      if (result.status === "failed") setError("Buzz couldn\u2019t open the source message.");
    }
    const available = data?.requests.filter(({ channel }) => channels.channels.some(
      (item) => item.id === channel && !item.cached && item.members?.includes(viewer)
    ));
    return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("div", { style: { ...row, justifyContent: "space-between" } }, /* @__PURE__ */ React.createElement("h1", { className: "text-title", style: { margin: 0 } }, "Human Review Inbox"), /* @__PURE__ */ React.createElement("button", { ...button, type: "button", "data-variant": "subtle", disabled: loading || !!working, onClick: () => {
      setQueued((previous) => Object.fromEntries(Object.entries(previous).filter(([, id]) => outbox.some(({ event }) => event.id === id))));
      refresh((value) => value + 1);
    } }, "Refresh")), loading && /* @__PURE__ */ React.createElement("p", { role: "status" }, "Loading review requests\u2026"), error && /* @__PURE__ */ React.createElement("p", { role: "alert" }, error), !loading && !error && !available?.length && /* @__PURE__ */ React.createElement("p", null, "No recent review requests addressed to you."), !!available?.length && /* @__PURE__ */ React.createElement("ul", { style: { display: "grid", gap: "var(--space-3)", listStyle: "none", padding: 0, margin: 0 } }, available.map((request) => {
      const receipt = data?.receipts.get(request.id);
      const operation = pendingReceipt(outbox, request);
      const channel = channels.channels.find(({ id }) => id === request.channel);
      const author = session.names.resolve(request.author, request.author.slice(0, 12));
      const canDecide = !!writableChannel(session, request.channel) && channel?.viewerRole !== "bot";
      return /* @__PURE__ */ React.createElement("li", { key: request.id, style: {
        display: "grid",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        minWidth: 0,
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-panel, 0.75rem)",
        overflowWrap: "anywhere"
      } }, /* @__PURE__ */ React.createElement("div", { className: "text-label" }, author, " \xB7 #", channel?.name ?? request.channel), /* @__PURE__ */ React.createElement("time", { className: "text-body-sm text-subtle", dateTime: new Date(request.createdAt * 1e3).toISOString() }, new Date(request.createdAt * 1e3).toLocaleString()), request.note && /* @__PURE__ */ React.createElement("p", { style: { margin: 0, whiteSpace: "pre-wrap" } }, request.note), /* @__PURE__ */ React.createElement("div", { style: row }, /* @__PURE__ */ React.createElement("button", { ...button, type: "button", "data-variant": "subtle", onClick: () => void openSource(request) }, "Open source"), !receipt && !operation && !queued[request.id] && canDecide && reviewDecisions.map((decision) => /* @__PURE__ */ React.createElement(
        "button",
        {
          ...button,
          key: decision,
          type: "button",
          "data-variant": decision === "Approve" ? "prominent" : "subtle",
          disabled: loading || !!working,
          onClick: () => void decide(request, decision)
        },
        decision
      ))), receipt ? /* @__PURE__ */ React.createElement("p", { className: "text-body-sm", style: { margin: 0 } }, "Recorded decision: ", receipt.decision) : operation ? /* @__PURE__ */ React.createElement("p", { role: "status", style: { margin: 0 } }, describeDelivery(operation)) : queued[request.id] ? /* @__PURE__ */ React.createElement("p", { role: "status", style: { margin: 0 } }, "Decision queued. Refresh to confirm delivery.") : !canDecide ? /* @__PURE__ */ React.createElement("p", { className: "text-body-sm text-subtle", style: { margin: 0 } }, "You don\u2019t have access to reply in this channel.") : null);
    })));
  }
  const ReviewPage = () => {
    const connection = useSyncExternalStore(ctx.relay.subscribe, ctx.relay.snapshot);
    return /* @__PURE__ */ React.createElement("section", { style: { display: "grid", gap: "var(--space-3)", padding: "var(--space-panel-inset)", maxWidth: "48rem" } }, connection.status === "ready" && !connection.cached && connection.viewer ? /* @__PURE__ */ React.createElement(Reviews, { key: connection.generation, connection, viewer: connection.viewer }) : /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("h1", { className: "text-title", style: { margin: 0 } }, "Human Review Inbox"), /* @__PURE__ */ React.createElement("p", { role: "status" }, "Connect to your Buzz community to see review requests.")));
  };
  ctx.pages.register({ id: "reviews", title: "Human Review Inbox", primary: true, component: ReviewPage });
  ctx.conversation.registerMessageAction({
    id: "request-human-review",
    title: "Request human review",
    component: RequestDialog,
    matches(message, session) {
      return !!(eventId2.test(message.id) && channelId2.test(message.channelId) && (!message.threadRootId || eventId2.test(message.threadRootId)) && (!message.delivery || message.delivery === "accepted" || message.delivery === "seen") && !message.membership && !message.huddle && !message.audience && !message.notice && writableChannel(session, message.channelId));
    }
  });
};
export {
  apply,
  inject
};
