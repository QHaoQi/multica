// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// QueryObserver's native timer path is enabled in a mobile runtime. Supply the
// same non-server environment without loading RN or rendering a DOM.
vi.hoisted(() => { vi.stubGlobal("window", {}); });
vi.mock("@/data/api", () => ({
  api: { getPendingChatTask: vi.fn(), listChatMessages: vi.fn() },
}));

import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { api } from "@/data/api";
import { chatKeys, chatMessagesOptions, pendingChatTaskOptions } from "./chat";
import type { ChatPendingTask } from "@multica/core/types";

describe("chat snapshot recovery", () => {
  let qc: QueryClient;
  const cleanup: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.getPendingChatTask).mockReset();
    vi.mocked(api.listChatMessages).mockReset();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    qc.mount();
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
  });

  afterEach(() => {
    cleanup.splice(0).forEach((unsub) => unsub());
    qc.unmount();
    qc.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("rechecks warm messages and pending state on foreground despite Infinity staleTime", async () => {
    qc.setQueryData(chatKeys.messages("A"), []);
    qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "running" });
    vi.mocked(api.listChatMessages).mockResolvedValue([]);
    vi.mocked(api.getPendingChatTask).mockResolvedValue({ task_id: "running" });
    const messages = new QueryObserver(qc, chatMessagesOptions("A"));
    const pending = new QueryObserver(qc, pendingChatTaskOptions("A"));
    cleanup.push(messages.subscribe(() => {}), pending.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(api.listChatMessages).mockClear();
    vi.mocked(api.getPendingChatTask).mockClear();

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(api.listChatMessages).toHaveBeenCalledTimes(1);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(1);
  });

  it("polls only an observed pending task and fetches the lost final reply when it finishes", async () => {
    qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "running" });
    qc.setQueryData(chatKeys.messages("A"), []);
    vi.mocked(api.getPendingChatTask)
      .mockResolvedValueOnce({ task_id: "running" })
      .mockResolvedValue({});
    const pending = new QueryObserver(qc, pendingChatTaskOptions("A"));
    cleanup.push(pending.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(2);
    expect(qc.getQueryData(chatKeys.pendingTask("A"))).toEqual({});
    expect(qc.getQueryState(chatKeys.messages("A"))?.isInvalidated).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(2);
  });

  it("rechecks a warm pending snapshot when connectivity returns without a WS event", async () => {
    qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "running" });
    vi.mocked(api.getPendingChatTask).mockResolvedValue({ task_id: "running" });
    const pending = new QueryObserver(qc, pendingChatTaskOptions("A"));
    cleanup.push(pending.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(api.getPendingChatTask).mockClear();
    onlineManager.setOnline(false);
    vi.mocked(api.getPendingChatTask).mockResolvedValue({});
    onlineManager.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(1);
    expect(qc.getQueryData(chatKeys.pendingTask("A"))).toEqual({});
  });

  it("does not poll in the background or after the session observer leaves", async () => {
    vi.mocked(api.getPendingChatTask).mockResolvedValue({ task_id: "running" });
    const pending = new QueryObserver(qc, pendingChatTaskOptions("A"));
    const unsub = pending.subscribe(() => {});
    cleanup.push(unsub);
    await vi.advanceTimersByTimeAsync(0);
    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(1);
    unsub();
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getPendingChatTask).toHaveBeenCalledTimes(1);
  });

  it("recovers messages when the server advances to a queued successor", async () => {
    qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask("A"), {
      task_id: "first", queued_tasks: [{ task_id: "next", status: "queued", created_at: "2026-10-06T00:00:00Z" }],
    });
    qc.setQueryData(chatKeys.messages("A"), []);
    vi.mocked(api.getPendingChatTask).mockResolvedValue({ task_id: "next", status: "running" });
    const pending = new QueryObserver(qc, pendingChatTaskOptions("A"));
    cleanup.push(pending.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask("A"))?.task_id).toBe("next");
    expect(qc.getQueryState(chatKeys.messages("A"))?.isInvalidated).toBe(true);
  });

  it("keeps retrying a visible pending task after a snapshot request fails", async () => {
    qc.setQueryData(chatKeys.pendingTask("A"), { task_id: "running" });
    vi.mocked(api.getPendingChatTask).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const pending = new QueryObserver(qc, pendingChatTaskOptions("A"));
    cleanup.push(pending.subscribe(() => {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(qc.getQueryData(chatKeys.pendingTask("A"))).toEqual({ task_id: "running" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(qc.getQueryData(chatKeys.pendingTask("A"))).toEqual({});
  });
});
