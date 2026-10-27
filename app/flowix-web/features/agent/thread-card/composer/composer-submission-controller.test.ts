import { describe, expect, it, vi } from "vitest";
import { ComposerSubmissionController } from "./composer-submission-controller";
import type { ComposerRuntimeState } from "./composer-submission-state";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const controller = new ComposerSubmissionController();
  let markdown = "[Review](flowix://skill/codex/review) hello";
  let disposed = false;
  const runtime: ComposerRuntimeState = {
    agentType: "codex", isModelRunning: false, isStopping: false,
    isCommandRunning: false, isCommandStoppable: false, isSubmitting: false, isAvailable: true,
  };
  const composer = {
    getPrompt: () => "$review hello", getDraftMarkdown: () => markdown,
    flushPendingDraft: vi.fn(), clearDraft: vi.fn(),
    clear: vi.fn(() => { markdown = ""; }),
    setHistoryValue: vi.fn((value: string) => { markdown = value; }),
    resetHistoryNavigation: vi.fn(), updateMultiLineState: vi.fn(),
  };
  const images = {
    hasAttachments: true, hasPending: false,
    readyAttachments: [{ path: "/tmp/file.png", mimeType: "image/png", name: "file.png" }],
    setLocked: vi.fn(), clearAfterSubmit: vi.fn(),
  };
  const phases: string[] = [];
  const options = {
    composer, images, getRuntime: () => runtime, isDisposed: () => disposed,
    bind: vi.fn(async () => ({ threadId: "thread-1" })),
    accept: vi.fn(async (): Promise<void> => undefined), clearPersistedDraft: vi.fn(),
    onPhaseChange: vi.fn(() => phases.push(controller.phase)), onError: vi.fn(),
  };
  return { controller, options, composer, images, phases, runtime,
    edit: (value: string) => { markdown = value; }, dispose: () => { disposed = true; } };
}

describe("composer submission transaction", () => {
  it("retains input through binding, clears on dispatch, and clears attachments on acceptance", async () => {
    const { controller, options, composer, images, phases } = setup();
    const bound = deferred();
    const accepted = deferred();
    options.bind.mockImplementation(async () => { await bound.promise; return { threadId: "thread-1" }; });
    options.accept.mockImplementation(() => accepted.promise);
    const submit = controller.submit(options);
    expect(controller.phase).toBe("binding");
    expect(composer.clear).not.toHaveBeenCalled();
    expect(images.clearAfterSubmit).not.toHaveBeenCalled();
    expect(images.setLocked).toHaveBeenCalledWith(true);
    bound.resolve();
    await vi.waitFor(() => expect(controller.phase).toBe("accepting"));
    expect(composer.clear).toHaveBeenCalledOnce();
    expect(composer.getDraftMarkdown()).toBe("");
    accepted.resolve();
    await submit;
    expect(phases).toEqual(["preparing", "binding", "accepting", "accepted"]);
    expect(composer.clear).toHaveBeenCalledOnce();
    expect(images.clearAfterSubmit).toHaveBeenCalledOnce();
    expect(controller.snapshot).toBeNull();
    expect(images.setLocked).toHaveBeenLastCalledWith(false);
  });

  it.each(["bind", "accept"] as const)("keeps a recoverable snapshot when %s fails", async (stage) => {
    const { controller, options, composer, images } = setup();
    options[stage].mockRejectedValueOnce(new Error("request rejected"));
    await controller.submit(options);
    expect(controller.phase).toBe("failed");
    // 快照字段已随属性统一改名为 attachments。
    expect(controller.snapshot).toMatchObject({
      markdown: "[Review](flowix://skill/codex/review) hello", prompt: "$review hello",
      attachments: [{ path: "/tmp/file.png" }],
    });
    if (stage === "bind") {
      expect(composer.clear).not.toHaveBeenCalled();
      expect(composer.clearDraft).not.toHaveBeenCalled();
      expect(images.clearAfterSubmit).not.toHaveBeenCalled();
      expect(options.clearPersistedDraft).not.toHaveBeenCalled();
    } else {
      expect(composer.clear).toHaveBeenCalledOnce();
      expect(composer.setHistoryValue).toHaveBeenCalledWith(
        "[Review](flowix://skill/codex/review) hello", { persistDraft: true },
      );
      expect(composer.getDraftMarkdown()).toBe("[Review](flowix://skill/codex/review) hello");
      expect(images.clearAfterSubmit).not.toHaveBeenCalled();
      expect(options.clearPersistedDraft).toHaveBeenCalledOnce();
    }
    expect(options.onError).toHaveBeenCalledOnce();
    expect(images.setLocked).toHaveBeenLastCalledWith(false);
    await controller.submit(options);
    expect(controller.phase).toBe("accepted");
  });

  it("blocks reentry while binding even for agents that support queued messages", async () => {
    const { controller, options } = setup();
    const gate = deferred();
    options.bind.mockImplementation(async () => { await gate.promise; return { threadId: "thread-1" }; });
    const first = controller.submit(options);
    await controller.submit(options);
    expect(options.bind).toHaveBeenCalledOnce();
    gate.resolve();
    await first;
    expect(options.accept).toHaveBeenCalledOnce();
  });

  it("keeps acceptance final when input cleanup fails", async () => {
    const { controller, options, composer } = setup();
    composer.clear.mockImplementationOnce(() => { throw new Error("cleanup failed"); });
    await controller.submit(options);
    expect(controller.phase).toBe("accepted");
    expect(options.accept).toHaveBeenCalledOnce();
    expect(controller.snapshot?.markdown).toContain("hello");
    expect(options.onError).toHaveBeenCalledOnce();
  });

  it("does not overwrite text edited while waiting for acceptance", async () => {
    const { controller, options, composer, edit } = setup();
    const gate = deferred();
    options.accept.mockImplementation(() => gate.promise);
    const first = controller.submit(options);
    await vi.waitFor(() => expect(controller.phase).toBe("accepting"));
    edit("a new follow-up");
    gate.resolve();
    await first;
    expect(composer.getDraftMarkdown()).toBe("a new follow-up");
    // The submitted draft clears at dispatch; acceptance must not clear the new draft again.
    expect(composer.clear).toHaveBeenCalledOnce();
    expect(options.clearPersistedDraft).toHaveBeenCalledOnce();
  });

  it("rechecks a command/stop that appeared during binding", async () => {
    const { controller, options, runtime, composer } = setup();
    options.bind.mockImplementation(async () => { runtime.isStopping = true; return { threadId: "thread-1" }; });
    await controller.submit(options);
    expect(controller.phase).toBe("failed");
    expect(options.accept).not.toHaveBeenCalled();
    expect(composer.clear).not.toHaveBeenCalled();
  });

  it("does not bind or clear while attachments are still being cached", async () => {
    const { controller, options, images, composer } = setup();
    images.hasPending = true;
    await controller.submit(options);
    expect(options.bind).not.toHaveBeenCalled();
    expect(composer.clear).not.toHaveBeenCalled();
  });

  it("ignores late completions after the surface is disposed", async () => {
    const { controller, options, composer, images, dispose } = setup();
    const gate = deferred();
    options.bind.mockImplementation(async () => { await gate.promise; return { threadId: "thread-1" }; });
    const submit = controller.submit(options);
    dispose();
    gate.resolve();
    await submit;
    expect(options.accept).not.toHaveBeenCalled();
    expect(composer.clear).not.toHaveBeenCalled();
    expect(images.setLocked).toHaveBeenCalledTimes(1);
    expect(controller.isSubmitting).toBe(false);
  });
});
