import { cloud, type CloudState } from "@platform/tauri/client";
import { isFlowixCloudModel } from "@features/agent/config/agent-model-source";
import { useAgentDataStore, type AgentModelCatalog } from "@features/agent/store/agent-data-store";
import { loadAgentModelCatalog, refreshAgentModelCatalog } from "./agent-catalog-service";

import { createLogger } from '@/lib/logger';
const logger = createLogger('agent/services/pi-cloud-model-service');
const pending = new Map<number, Promise<AgentModelCatalog>>();

function applyCloudState(state: CloudState): boolean {
  const store = useAgentDataStore.getState();
  if (state.revision < store.piCloudRevision) return false;
  store.setPiCloudAccount(
    state.authenticated ? state.account?.user.id ?? null : null,
    state.revision,
    state.membership,
  );
  return true;
}

/** Events and explicit snapshots use the same revision gate in the store. */
export function syncPiCloudModelCatalog(state: CloudState): Promise<AgentModelCatalog> {
  const previousEpoch = useAgentDataStore.getState().piCloudCatalogEpoch;
  const accepted = applyCloudState(state);
  const current = useAgentDataStore.getState();
  if (!accepted || !current.piCloudAccountId) {
    return Promise.resolve(current.agents.pi.catalog.models);
  }
  const sessionChanged = current.piCloudCatalogEpoch !== previousEpoch;
  if (!sessionChanged && current.agents.pi.catalog.models.items.some(isFlowixCloudModel)) {
    return Promise.resolve(current.agents.pi.catalog.models);
  }
  return ensurePiCloudModelCatalog({ force: sessionChanged });
}

/** Reconcile on opening the picker, including a missed native session event. */
export async function loadPiCloudModelCatalog(options: { force?: boolean } = {}): Promise<AgentModelCatalog> {
  try {
    const state = await cloud.getState();
    applyCloudState(state);
  } catch (error) {
    logger.warn('Failed to reconcile Cloud session before loading Pi models', { error });
  }
  return ensurePiCloudModelCatalog(options);
}

function ensurePiCloudModelCatalog(options: { force?: boolean } = {}): Promise<AgentModelCatalog> {
  const store = useAgentDataStore.getState();
  if (!store.piCloudAccountId) {
    return loadAgentModelCatalog("pi", options);
  }
  const epoch = store.piCloudCatalogEpoch;
  const existing = pending.get(epoch);
  if (existing) return existing;
  store.setPiCloudModelLoadState(epoch, { status: "loading" });
  const request = (async () => {
    const enabled = await cloud.piModelAvailability();
    const hasCloudModels = useAgentDataStore.getState().agents.pi.catalog.models.items
      .some(isFlowixCloudModel);
    if (!options.force && enabled === hasCloudModels) {
      return loadAgentModelCatalog("pi", options);
    }
    // Refresh the local catalog only when it disagrees with the global switch
    // or when the account session changed.
    const alreadyConnected = await cloud.refreshPiModelProvider();
    const connected = alreadyConnected || await cloud.refreshPiModelProviderAtStartup();
    const current = useAgentDataStore.getState();
    if (current.piCloudCatalogEpoch !== epoch) return current.agents.pi.catalog.models;
    return connected
      ? refreshAgentModelCatalog("pi")
      : loadAgentModelCatalog("pi", { force: true });
  })().then((catalog) => {
    useAgentDataStore.getState().setPiCloudModelLoadState(epoch, { status: "ready" });
    return catalog;
  }, (error: unknown) => {
    useAgentDataStore.getState().setPiCloudModelLoadState(epoch, {
      status: "error", error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }).finally(() => pending.delete(epoch));
  pending.set(epoch, request);
  return request;
}
