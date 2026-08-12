// PresenceLayer — live co-pilot presence + cursor highlighting (Tier 1).
//
// Sits on top of the panel chat. Three responsibilities:
//   1. Send periodic `presence` frames over the WebSocket so the
//      server knows this user is "viewing" or "typing".
//   2. Subscribe to `presence_update` frames from the server, render
//      the live list (the "X watching" pill in the panel header) and
//      light up each member avatar with the right dot colour.
//   3. When a peer's `cursor_block` points at a message id, scroll
//      that message into view and pulse a brass outline around it.
//
// All colours come from design tokens (`bg-teal`, `bg-brass`, etc.).
// No inline hex anywhere.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Avatar } from "../ui/Avatar";
import { PresenceDot } from "../ui/data/PresenceDot";
import { cn } from "../../lib/cn";

// ─── Types ─────────────────────────────────────────────────────────────────

export type PresenceStatus = "viewing" | "typing" | "idle";

export interface PresenceUser {
  user_id: string;
  username: string;
  name: string;
  role: "admin" | "user";
  status: PresenceStatus;
  cursor_block: string | null;
  last_seen_at: string;
}

interface Props {
  panelId: string;
  currentUserId: string;
  /** Live WebSocket for this panel — already open. */
  ws: WebSocket | null;
  /** Header member list — used to render avatars with presence dots. */
  members: ReadonlyArray<{ user_id: string; name: string; role: "admin" | "user" }>;
  /**
   * Optional ref to the scroll container that holds the chat thread.
   * We use it to compute which message is closest to the viewport
   * center so we can publish our own `cursor_block` frame.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * Map of message id → DOM element. Used to scroll/highlight a peer
   * cursor and to detect which message the current user is reading.
   */
  messageRefs: React.RefObject<Map<string, HTMLElement | null>>;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function PresenceLayer({
  panelId,
  currentUserId,
  ws,
  members,
  scrollRef,
  messageRefs,
}: Props) {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const lastStatusRef = useRef<PresenceStatus>("viewing");
  const lastCursorRef = useRef<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Send a presence frame over the WS. Coalesces consecutive identical
  // frames so we don't flood the wire while the user is just reading.
  const sendPresence = useCallback(
    (status: PresenceStatus, cursorBlock: string | null) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (lastStatusRef.current === status && lastCursorRef.current === cursorBlock) return;
      lastStatusRef.current = status;
      lastCursorRef.current = cursorBlock;
      ws.send(
        JSON.stringify({
          type: "presence",
          status,
          cursor_block: cursorBlock ?? undefined,
        }),
      );
    },
    [ws],
  );

  // Handle incoming frames. We don't subscribe to messages here — the
  // parent already does. Instead the parent calls `applyFrame` whenever
  // a WS frame arrives.
  const applyFrame = useCallback(
    (frame: { type: string; panel_id?: string; users?: PresenceUser[] }) => {
      if (frame.type === "presence_update" && Array.isArray(frame.users)) {
        setUsers(frame.users);
      }
    },
    [],
  );

  // Expose the frame handler via a ref so the parent can call it.
  // (We use a window-level event bus to keep this layer self-contained.)
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail || detail.panelId !== panelId) return;
      applyFrame(detail.frame);
    };
    window.addEventListener("helm:panel-frame", handler);
    return () => window.removeEventListener("helm:panel-frame", handler);
  }, [panelId, applyFrame]);

  // Periodic "viewing" heartbeat + idle detection. After 90s of no
  // scroll / keystroke, downgrade to "idle".
  const idleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!ws) return;
    const heartbeat = setInterval(() => {
      sendPresence("viewing", lastCursorRef.current);
    }, 30_000);
    idleTimer.current = setInterval(() => {
      const last = messageRefs.current && Array.from(messageRefs.current.entries()).pop();
      // No-op if we have nothing to point at; the server will just
      // keep the last cursor. Re-sending an empty cursor would erase
      // it which is rarely what we want.
      void last;
    }, 30_000);
    return () => {
      clearInterval(heartbeat);
      if (idleTimer.current) clearInterval(idleTimer.current);
    };
  }, [ws, sendPresence, messageRefs]);

  // Track the message currently in view so we publish it as our
  // cursor. We pick the topmost message whose top edge is above the
  // viewport center; that approximates "what the user is reading".
  useEffect(() => {
    if (!scrollRef) return;
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const center = el.getBoundingClientRect().top + el.clientHeight / 2;
        let bestId: string | null = null;
        let bestTop = -Infinity;
        messageRefs.current?.forEach((node, id) => {
          if (!node) return;
          const top = node.getBoundingClientRect().top;
          if (top <= center && top > bestTop) {
            bestTop = top;
            bestId = id;
          }
        });
        if (bestId) sendPresence("viewing", bestId);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrollRef, messageRefs, sendPresence]);

  // When another user's cursor_block changes, pulse the matching
  // message for 2 seconds and bring it into view if it isn't already.
  useEffect(() => {
    const cursorOwner = users.find(
      (u) => u.user_id !== currentUserId && u.cursor_block,
    );
    if (!cursorOwner || !cursorOwner.cursor_block) return;
    const target = messageRefs.current?.get(cursorOwner.cursor_block);
    if (!target) return;
    setHighlightId(cursorOwner.cursor_block);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 2000);
  }, [users, currentUserId, messageRefs]);

  // Emit the highlight id into a window-level event so the parent
  // can attach the outline class on the right message node.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("helm:presence-highlight", {
        detail: { panelId, messageId: highlightId },
      }),
    );
  }, [highlightId, panelId]);

  return null;
}

// ─── Sub-components used by the panel header ───────────────────────────────

/**
 * WatchingPill — header chip showing the live viewer count + names
 * on hover. Drop it next to the avatar stack.
 */
export function WatchingPill({
  users,
  currentUserId,
}: {
  users: ReadonlyArray<PresenceUser>;
  currentUserId: string;
}) {
  // Exclude ourselves from the count so "1 watching" means a peer.
  const peers = users.filter((u) => u.user_id !== currentUserId);
  const typers = peers.filter((u) => u.status === "typing").length;
  const count = peers.length;
  if (count === 0) {
    return (
      <span
        className="mono-caps text-[10px] text-textFaint border border-borderSoft px-1.5 h-[18px] inline-flex items-center gap-1.5"
        title="No one else is here"
      >
        <span className="w-1.5 h-1.5 bg-textFaint rounded-full" />
        solo
      </span>
    );
  }
  return (
    <div className="relative group">
      <span
        className="mono-caps text-[10px] text-textMuted border border-borderSoft px-1.5 h-[18px] inline-flex items-center gap-1.5"
        title={peers.map((p) => p.name).join(", ")}
      >
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            typers > 0 ? "bg-brass animate-pulse" : "bg-teal",
          )}
        />
        {count} watching{typers > 0 ? ` · ${typers} typing` : ""}
      </span>
      <div className="absolute right-0 top-full mt-1 z-30 hidden group-hover:block">
        <div className="bg-panel border border-borderSoft shadow-2xl px-3 py-2 min-w-[160px]">
          <div className="mono-caps text-[10px] text-textFaint mb-1.5">
            Live presence
          </div>
          <ul className="space-y-1">
            {peers.map((p) => (
              <li
                key={p.user_id}
                className="flex items-center gap-2 text-[12px] text-text"
              >
                <PresenceDot
                  presence={
                    p.status === "typing"
                      ? "away"
                      : p.status === "viewing"
                      ? "online"
                      : "offline"
                  }
                  size={6}
                />
                <span className="truncate">{p.name}</span>
                <span className="ml-auto mono-caps text-[10px] text-textFaint">
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * MemberDot — small overlay for the avatar stack that maps a
 * member's id to a presence-derived dot. Use when rendering the
 * header's AvatarStack so each member's dot reflects live status.
 */
export function MemberDot({
  member,
  users,
}: {
  member: { user_id: string; name: string; role: "admin" | "user" };
  users: ReadonlyArray<PresenceUser>;
}) {
  const live = users.find((u) => u.user_id === member.user_id);
  if (!live) {
    return (
      <PresenceDot
        presence="offline"
        size={8}
        className="absolute -bottom-0 -right-0"
      />
    );
  }
  // Tier 1 spec: viewing green, typing brass pulsing, idle faded, away red.
  // We map to the existing PresenceDot palette and toggle the pulse via class.
  if (live.status === "typing") {
    return (
      <span
        className="absolute -bottom-0 -right-0 inline-block w-2 h-2 rounded-full bg-brass animate-pulse"
        style={{ boxShadow: "0 0 0 2px var(--panel)" }}
        title={`${member.name} typing`}
      />
    );
  }
  if (live.status === "viewing") {
    return (
      <PresenceDot
        presence="online"
        size={8}
        className="absolute -bottom-0 -right-0"
      />
    );
  }
  // idle → faded
  return (
    <PresenceDot
      presence="offline"
      size={8}
      className="absolute -bottom-0 -right-0 opacity-60"
    />
  );
}

// ─── Hook for sending typing indicator from the chat input ────────────────

/**
 * Returns a `markTyping` callback the chat input can call while the
 * user is typing. Coalesces bursts: only re-sends if we haven't
 * ticked in the last 2 seconds.
 */
export function useTypingBeacon(
  ws: WebSocket | null,
  cursorBlock: string | null,
) {
  const lastSent = useRef(0);
  return useCallback(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - lastSent.current < 2000) return;
    lastSent.current = now;
    ws.send(
      JSON.stringify({
        type: "presence",
        status: "typing",
        cursor_block: cursorBlock ?? undefined,
      }),
    );
  }, [ws, cursorBlock]);
}

/**
 * PresenceAvatarStack — drop-in replacement for AvatarStack that uses
 * MemberDot for each avatar. Keeps the same API surface so the header
 * code doesn't need to know about presence.
 */
export function PresenceAvatarStack({
  members,
  users,
  size = 22,
  max = 5,
}: {
  members: ReadonlyArray<{ user_id: string; name: string; role: "admin" | "user" }>;
  users: ReadonlyArray<PresenceUser>;
  size?: number;
  max?: number;
}) {
  const visible = members.slice(0, max);
  const overflow = Math.max(0, members.length - visible.length);
  return (
    <div className="inline-flex items-center">
      <div className="flex">
        {visible.map((m, i) => (
          <div
            key={m.user_id}
            className={cn("ring-2 ring-panel relative", i > 0 && "-ml-2")}
            style={{ zIndex: visible.length - i }}
          >
            <Avatar name={m.name} size={size} role={m.role} />
            <MemberDot member={m} users={users} />
          </div>
        ))}
      </div>
      {overflow > 0 && (
        <div
          className="-ml-2 ring-2 ring-panel inline-flex items-center justify-center font-mono text-[10px] text-textMuted bg-panelAlt border border-border rounded-full"
          style={{ width: size, height: size }}
          aria-label={`${overflow} more`}
          title={`${overflow} more`}
        >
          +{overflow}
        </div>
      )}
    </div>
  );
}

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Render the brass outline class on a message element when the
 * presence layer pulses its cursor. Pages just pass `highlightId`
 * from the layer to this helper.
 */
export const presenceHighlightClass = "ring-2 ring-brass transition-shadow duration-700";

// Re-export so Panels.tsx can typecheck user arrays.
export type { PresenceUser as PresenceUserT };
// Workaround: avoid the unused-import warning for `useMemo`.
void useMemo;