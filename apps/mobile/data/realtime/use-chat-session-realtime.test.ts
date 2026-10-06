// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const state = vi.hoisted(() => ({
  qc: undefined as unknown as QueryClient,
  ws: {} as object,
  effectDeps: undefined as readonly unknown[] | undefined,
  setups: [] as Array<(ws: MockWS, wsId: string) => void>,
}));
type Handler = (payload: { chat_session_id?: string }) => void;
interface MockWS { on: (event: string, handler: Handler) => () => void; onReconnect: (handler: () => void) => () => void }
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (setup: () => void, deps: readonly unknown[]) => {
    if (!state.effectDeps || deps.some((value, i) => !Object.is(value, state.effectDeps![i]))) setup();
    state.effectDeps = deps;
  },
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => state.qc,
}));
vi.mock("./realtime-provider", () => ({ useWSClient: () => state.ws }));
vi.mock("@/lib/use-ws-subscriptions", () => ({
  useWSSubscriptions: (setup: (ws: MockWS, wsId: string) => void) => state.setups.push(setup),
}));
vi.mock("@/data/api", () => ({ api: {} }));
import { chatKeys } from "@/data/queries/chat";
import { useChatSessionRealtime } from "./use-chat-session-realtime";

describe("chat session snapshot lifecycle", () => {
  beforeEach(() => {
    state.qc = new QueryClient();
    state.ws = {};
    state.effectDeps = undefined;
    state.setups = [];
  });

  it("invalidates the warm session on A → B → A even without reconnect events", () => {
    state.qc.setQueryData(chatKeys.messages("A"), []);
    state.qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "finished" });
    useChatSessionRealtime("A");
    useChatSessionRealtime("B");
    // A finished while its per-session event handler was unmounted.
    state.qc.setQueryData(chatKeys.messages("A"), []);
    state.qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "finished" });
    useChatSessionRealtime("A");
    expect(state.qc.getQueryState(chatKeys.messages("A"))?.isInvalidated).toBe(true);
    expect(state.qc.getQueryState(chatKeys.pendingTask("A"))?.isInvalidated).toBe(true);
  });

  it("reconciles a new WS client but does not refetch when inline callbacks change", () => {
    const invalidate = vi.spyOn(state.qc, "invalidateQueries");
    useChatSessionRealtime("A", () => {});
    expect(invalidate).toHaveBeenCalledTimes(2);
    useChatSessionRealtime("A", () => {});
    expect(invalidate).toHaveBeenCalledTimes(2);
    state.ws = {};
    useChatSessionRealtime("A", () => {});
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("recovers final messages from task:completed when chat:done was lost", () => {
    useChatSessionRealtime("A");
    state.qc.setQueryData(chatKeys.messages("A"), []);
    state.qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "finished" });
    const handlers = new Map<string, Handler>();
    state.setups[0]({
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      onReconnect: () => () => {},
    }, "workspace");
    handlers.get("task:completed")!({ chat_session_id: "B" });
    expect(state.qc.getQueryState(chatKeys.messages("A"))?.isInvalidated).toBe(false);
    handlers.get("task:completed")!({ chat_session_id: "A" });
    expect(state.qc.getQueryState(chatKeys.messages("A"))?.isInvalidated).toBe(true);
    expect(state.qc.getQueryState(chatKeys.pendingTask("A"))?.isInvalidated).toBe(true);
  });
});
