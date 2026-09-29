import { useDocumentStore } from "@features/document/store/document-store";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-types";

export function getCurrentThreadCardSource(): AgentConversationSource {
  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === "external") {
    return {
      kind: "thread-card",
      documentPath: documentState.currentDocumentPath ?? null,
      relativePath: documentState.activeExternalSession?.relativePath ?? null,
      notebookId: documentState.activeExternalSession?.notebookId ?? null,
    };
  }
  return { kind: "thread-card" };
}
