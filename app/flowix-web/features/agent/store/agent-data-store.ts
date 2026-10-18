import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createLogger } from "@/lib/logger";
import { STORAGE_KEYS } from "@/lib/constants";
import { piModels } from "@platform/tauri/client";
import type {
  AgentCodexReasoningEffort,
  AgentCodexServiceTier,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import {
  getAgentAccessOptions,
  getAgentModeOptions,
  type AgentAccessOption,
  type AgentModeOption,
} from "@features/agent/runtime/agent-runtime-spec";
import { getFallbackAgentModelOptions } from "@features/agent/config/agent-model-options";
import { normalizeAgentId } from "@/lib/agent-types";

const logger = createLogger("agent-data-store");
const PERSISTENCE_STATUS_EVENT = "flowix-agent-data-persistence-status";
let lastPersistenceError: string | null = null;

function updatePersistenceError(error: string | null): void {
  if (lastPersistenceError === error) return;
  lastPersistenceError = error;
  if (typeof window === "undefined") return;
  queueMicrotask(() => {
    window.dispatchEvent(new CustomEvent(PERSISTENCE_STATUS_EVENT, { detail: { error } }));
  });
}

// A failed browser-cache write must not prevent backend-owned workspace loading.
const agentStorage = {
  getItem: (name: string): string | null => {
    try { return localStorage.getItem(name); }
    catch (error) { logger.warn("Agent cache read failed", { error }); updatePersistenceError(errorMessage(error)); return null; }
  },
  setItem: (name: string, value: string): void => {
    try {
      const mergedValue = mergeSerializedAgentData(localStorage.getItem(name), value);
      localStorage.setItem(name, mergedValue);
      updatePersistenceError(null);
    } catch (error) {
      logger.warn("Agent cache write failed", { error });
      updatePersistenceError(errorMessage(error));
    }
  },
  removeItem: (name: string): void => {
    try { localStorage.removeItem(name); }
    catch (error) { logger.warn("Agent cache removal failed", { error }); updatePersistenceError(errorMessage(error)); }
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AgentCatalogModel {
  id: string;
  label: string;
  description?: string;
  subtitle?: string;
  creditMultiplier?: number;
  iconUrl?: string;
  providerId?: string;
  providerName?: string;
  reasoningEfforts?: AgentCodexReasoningEffort[];
}

export interface AgentCatalogSkill {
  name: string;
  description: string;
  displayName?: string;
  shortDescription?: string;
  whenToUse?: string;
  modelInvocable?: boolean;
  scope?: string;
  path?: string;
  enabled?: boolean;
}

export interface AgentModelCatalog {
  items: AgentCatalogModel[];
  defaultModel?: string;
  defaultProviderId?: string;
  updatedAt?: number;
}

export interface AgentCapabilities {
  permissions: readonly AgentAccessOption[];
  modes: readonly AgentModeOption[];
}

export interface AgentUserPreference {
  model?: { id: string; providerId?: string };
  permission?: AgentPermissionMode;
  mode?: string;
  reasoningEffort?: AgentCodexReasoningEffort;
  reasoningByModel?: Record<string, AgentCodexReasoningEffort>;
  serviceTier?: AgentCodexServiceTier;
}

interface AgentCatalogState {
  models: AgentModelCatalog;
  skillsByNotebookId: Record<string, {
    items: AgentCatalogSkill[];
    updatedAt?: number;
  }>;
  /** Built from the current runtime spec and omitted from the persisted snapshot. */
  capabilities: AgentCapabilities;
}

interface AgentDataRecord {
  catalog: AgentCatalogState;
  user: AgentUserPreference;
}

interface AgentDataLoadState {
  piMode: { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };
}

export interface AgentDataStoreState {
  /** One-time import of legacy Codex session settings. */
  legacyPreferencesMigrated: boolean;
  /** Per-field revisions make user choices mergeable across app windows. */
  userPreferenceRevisions: Partial<Record<AgentTypeKey, Record<string, string>>>;
  /** Transient UI status; deliberately excluded from localStorage. */
  persistenceError: string | null;
  agents: Record<AgentTypeKey, AgentDataRecord>;
  loadState: AgentDataLoadState;
  initializePiMode: () => Promise<void>;
  initializeLegacySessionSettings: () => Promise<void>;
  setModelCatalog: (agentType: AgentTypeKey, catalog: AgentModelCatalog) => void;
  invalidateModelCatalog: (agentType: AgentTypeKey) => void;
  invalidateSkillCatalog: (agentType: AgentTypeKey, notebookId: string) => void;
  loadModelCatalog: (
    agentType: AgentTypeKey,
    loader: () => Promise<AgentModelCatalog>,
    options?: { force?: boolean; maxAgeMs?: number },
  ) => Promise<AgentModelCatalog>;
  setSkillCatalog: (
    agentType: AgentTypeKey,
    notebookId: string,
    items: AgentCatalogSkill[],
  ) => void;
  loadSkillCatalog: (
    agentType: AgentTypeKey,
    notebookId: string,
    loader: () => Promise<AgentCatalogSkill[]>,
    options?: { force?: boolean; maxAgeMs?: number },
  ) => Promise<AgentCatalogSkill[]>;
  setUserPreference: (
    agentType: AgentTypeKey,
    patch: Partial<AgentUserPreference>,
  ) => void;
  rememberModelReasoning: (
    agentType: AgentTypeKey,
    model: { id: string; providerId?: string } | undefined,
    effort: AgentCodexReasoningEffort,
  ) => void;
  migrateLegacySessionSettings: (codexSessionSettings?: {
    agentCodexModel: string;
    agentPermissionMode: AgentPermissionMode;
    agentCodexReasoningEffort: AgentCodexReasoningEffort;
  }) => void;
}

const AGENT_TYPES: AgentTypeKey[] = [
  "codex", "claudecode", "hermes", "opencode", "pi", "dsh",
];

function canonicalAgentMap<T>(source: object | undefined): Partial<Record<AgentTypeKey, T>> {
  const result: Partial<Record<AgentTypeKey, T>> = {};
  if (!source) return result;
  // Merge legacy fields first, then let explicitly canonical values win field
  // conflicts while retaining any fields present only in the old record.
  const entries = Object.entries(source as Record<string, T>).sort(([left], [right]) =>
    Number(left === normalizeAgentId(left)) - Number(right === normalizeAgentId(right)),
  );
  for (const [key, value] of entries) {
    const id = normalizeAgentId(key);
    if (!id) continue;
    const previous = result[id];
    if (!previous || typeof previous !== "object" || !value || typeof value !== "object") {
      result[id] = value;
      continue;
    }
    const merged = { ...(previous as Record<string, unknown>), ...(value as Record<string, unknown>) };
    for (const nestedKey of Object.keys(value as Record<string, unknown>)) {
      const before = (previous as Record<string, unknown>)[nestedKey];
      const after = (value as Record<string, unknown>)[nestedKey];
      if (before && after && typeof before === "object" && typeof after === "object") {
        merged[nestedKey] = { ...(before as object), ...(after as object) };
      }
    }
    result[id] = merged as T;
  }
  return result;
}

function createAgentRecord(agentType: AgentTypeKey): AgentDataRecord {
  return {
    catalog: {
      models: { items: getFallbackAgentModelOptions(agentType) },
      skillsByNotebookId: {},
      capabilities: {
        permissions: getAgentAccessOptions(agentType),
        modes: getAgentModeOptions(agentType),
      },
    },
    user: {},
  };
}

function createInitialAgents(): Record<AgentTypeKey, AgentDataRecord> {
  return Object.fromEntries(
    AGENT_TYPES.map((agentType) => [agentType, createAgentRecord(agentType)]),
  ) as Record<AgentTypeKey, AgentDataRecord>;
}

const MODEL_CATALOG_MAX_AGE_MS = 5 * 60 * 1000;
const SKILL_CATALOG_MAX_AGE_MS = 60 * 1000;
const pendingModelLoads = new Map<AgentTypeKey, Promise<AgentModelCatalog>>();
const pendingSkillLoads = new Map<string, Promise<AgentCatalogSkill[]>>();
let pendingPiModeInitialization: Promise<void> | null = null;
let pendingLegacySessionInitialization: Promise<void> | null = null;

function skillLoadKey(agentType: AgentTypeKey, notebookId: string): string {
  return `${agentType}:${notebookId}`;
}

export function modelPreferenceKey(model: { id: string; providerId?: string }): string {
  return JSON.stringify([model.providerId?.trim() ?? "", model.id.trim()]);
}

function nextPreferenceRevision(): string {
  return `${Date.now().toString().padStart(13, "0")}:${Math.random().toString(36).slice(2)}`;
}

function compareRevisions(left?: string, right?: string): number {
  if (left === right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.localeCompare(right);
}

// Defaults must lose to imported preferences, which must lose to user choices.
const DEFAULT_PREFERENCE_REVISION = "0000000000000:default";
function isImportedPreferenceRevision(revision?: string): boolean {
  return revision?.startsWith("0000000000000:") ?? false;
}

function preferenceValueChanged(left: unknown, right: unknown): boolean {
  return stableSerialize(left) !== stableSerialize(right);
}

function stampChangedPreferenceFields(
  revisions: Record<string, string>,
  before: AgentUserPreference,
  after: AgentUserPreference,
): Record<string, string> {
  const next = { ...revisions };
  for (const key of new Set([
    ...Object.keys(before).filter((name) => name !== "reasoningByModel"),
    ...Object.keys(after).filter((name) => name !== "reasoningByModel"),
  ])) {
    if (preferenceValueChanged(before[key as keyof AgentUserPreference], after[key as keyof AgentUserPreference])) {
      next[key] = nextPreferenceRevision();
    }
  }
  const beforeReasoning = before.reasoningByModel ?? {};
  const afterReasoning = after.reasoningByModel ?? {};
  for (const key of new Set([...Object.keys(beforeReasoning), ...Object.keys(afterReasoning)])) {
    if (beforeReasoning[key] !== afterReasoning[key]) {
      next[`reasoningByModel:${key}`] = nextPreferenceRevision();
    }
  }
  return next;
}

function stampLegacyPreferenceFields(
  revisions: Record<string, string>,
  before: AgentUserPreference,
  after: AgentUserPreference,
): Record<string, string> {
  const next = { ...revisions };
  const legacyRevision = "0000000000000:legacy";
  for (const key of new Set([
    ...Object.keys(before).filter((name) => name !== "reasoningByModel"),
    ...Object.keys(after).filter((name) => name !== "reasoningByModel"),
  ])) {
    if (preferenceValueChanged(before[key as keyof AgentUserPreference], after[key as keyof AgentUserPreference])) {
      next[key] = legacyRevision;
    }
  }
  const beforeReasoning = before.reasoningByModel ?? {};
  const afterReasoning = after.reasoningByModel ?? {};
  for (const key of new Set([...Object.keys(beforeReasoning), ...Object.keys(afterReasoning)])) {
    if (beforeReasoning[key] !== afterReasoning[key]) {
      next[`reasoningByModel:${key}`] = legacyRevision;
    }
  }
  return next;
}

function mergeUserPreferenceSnapshots(
  left: AgentUserPreference | undefined,
  right: AgentUserPreference | undefined,
  leftRevisions: Record<string, string> = {},
  rightRevisions: Record<string, string> = {},
): AgentUserPreference {
  const leftUser = left ?? {};
  const rightUser = right ?? {};
  const merged: AgentUserPreference = {};
  const fields = new Set([
    ...Object.keys(leftUser).filter((key) => key !== "reasoningByModel"),
    ...Object.keys(rightUser).filter((key) => key !== "reasoningByModel"),
    ...Object.keys(leftRevisions).filter((key) => !key.startsWith("reasoningByModel:")),
    ...Object.keys(rightRevisions).filter((key) => !key.startsWith("reasoningByModel:")),
  ]);
  for (const field of fields) {
    const leftRevision = leftRevisions[field];
    const rightRevision = rightRevisions[field];
    const leftHasValue = Object.prototype.hasOwnProperty.call(leftUser, field);
    const rightHasValue = Object.prototype.hasOwnProperty.call(rightUser, field);
    const useRight = isImportedPreferenceRevision(rightRevision) && !leftRevision && leftHasValue
      ? false
      : isImportedPreferenceRevision(leftRevision) && !rightRevision && rightHasValue
        ? true
        : compareRevisions(leftRevision, rightRevision) <= 0;
    const chosen = useRight ? rightUser : leftUser;
    const hasValue = Object.prototype.hasOwnProperty.call(chosen, field);
    const value = chosen[field as keyof AgentUserPreference];
    if (hasValue && value !== undefined) (merged as Record<string, unknown>)[field] = value;
  }

  const leftReasoning = leftUser.reasoningByModel ?? {};
  const rightReasoning = rightUser.reasoningByModel ?? {};
  const reasoningKeys = new Set([
    ...Object.keys(leftReasoning),
    ...Object.keys(rightReasoning),
    ...Object.keys(leftRevisions).filter((key) => key.startsWith("reasoningByModel:")).map((key) => key.slice("reasoningByModel:".length)),
    ...Object.keys(rightRevisions).filter((key) => key.startsWith("reasoningByModel:")).map((key) => key.slice("reasoningByModel:".length)),
  ]);
  const reasoningByModel: Record<string, AgentCodexReasoningEffort> = {};
  for (const key of reasoningKeys) {
    const revisionKey = `reasoningByModel:${key}`;
    const leftRevision = leftRevisions[revisionKey];
    const rightRevision = rightRevisions[revisionKey];
    const leftHasValue = Object.prototype.hasOwnProperty.call(leftReasoning, key);
    const rightHasValue = Object.prototype.hasOwnProperty.call(rightReasoning, key);
    const useRight = isImportedPreferenceRevision(rightRevision) && !leftRevision && leftHasValue
      ? false
      : isImportedPreferenceRevision(leftRevision) && !rightRevision && rightHasValue
        ? true
        : compareRevisions(leftRevision, rightRevision) <= 0;
    const value = useRight ? rightReasoning[key] : leftReasoning[key];
    if (value !== undefined) reasoningByModel[key] = value;
  }
  if (Object.keys(reasoningByModel).length) merged.reasoningByModel = reasoningByModel;
  return merged;
}

function mergeRevisionMaps(
  left: AgentDataStoreState["userPreferenceRevisions"] | undefined,
  right: AgentDataStoreState["userPreferenceRevisions"] | undefined,
): AgentDataStoreState["userPreferenceRevisions"] {
  const merged: NonNullable<AgentDataStoreState["userPreferenceRevisions"]> = {};
  left = canonicalAgentMap(left);
  right = canonicalAgentMap(right);
  for (const agentType of AGENT_TYPES) {
    const leftFields = left?.[agentType] ?? {};
    const rightFields = right?.[agentType] ?? {};
    const fields: Record<string, string> = {};
    for (const key of new Set([...Object.keys(leftFields), ...Object.keys(rightFields)])) {
      fields[key] = compareRevisions(leftFields[key], rightFields[key]) <= 0
        ? rightFields[key]
        : leftFields[key];
    }
    if (Object.keys(fields).length) merged[agentType] = fields;
  }
  return merged;
}

function mergeCatalogSnapshots(
  left: AgentCatalogState | undefined,
  right: AgentCatalogState | undefined,
): AgentCatalogState {
  const leftCatalog: AgentCatalogState = left ?? {
    models: { items: [] },
    skillsByNotebookId: {},
    capabilities: { permissions: [], modes: [] },
  };
  const rightCatalog = right ?? leftCatalog;
  const leftModelsAt = leftCatalog.models.updatedAt ?? -1;
  const rightModelsAt = rightCatalog.models.updatedAt ?? -1;
  const skillsByNotebookId = { ...leftCatalog.skillsByNotebookId };
  for (const [notebookId, skillCatalog] of Object.entries(rightCatalog.skillsByNotebookId)) {
    if ((skillCatalog.updatedAt ?? -1) >= (skillsByNotebookId[notebookId]?.updatedAt ?? -1)) {
      skillsByNotebookId[notebookId] = skillCatalog;
    }
  }
  return {
    models: rightModelsAt >= leftModelsAt ? rightCatalog.models : leftCatalog.models,
    skillsByNotebookId,
    capabilities: rightCatalog.capabilities ?? leftCatalog.capabilities,
  };
}

function mergeAgentSnapshots(
  leftAgents: Partial<Record<AgentTypeKey, AgentDataRecord>> | undefined,
  rightAgents: Partial<Record<AgentTypeKey, AgentDataRecord>> | undefined,
  leftRevisions: AgentDataStoreState["userPreferenceRevisions"] | undefined,
  rightRevisions: AgentDataStoreState["userPreferenceRevisions"] | undefined,
): Record<AgentTypeKey, AgentDataRecord> {
  leftAgents = canonicalAgentMap(leftAgents);
  rightAgents = canonicalAgentMap(rightAgents);
  const merged = createInitialAgents();
  for (const agentType of AGENT_TYPES) {
    const left = leftAgents?.[agentType] ?? merged[agentType];
    const right = rightAgents?.[agentType] ?? left;
    merged[agentType] = {
      catalog: mergeCatalogSnapshots(left.catalog, right.catalog),
      user: mergeUserPreferenceSnapshots(
        left.user,
        right.user,
        leftRevisions?.[agentType],
        rightRevisions?.[agentType],
      ),
    };
  }
  return merged;
}

function mergePersistedAgentSlices(left: Record<string, any>, right: Record<string, any>): Record<string, any> {
  const leftRevisions = left.userPreferenceRevisions as AgentDataStoreState["userPreferenceRevisions"] | undefined;
  const rightRevisions = right.userPreferenceRevisions as AgentDataStoreState["userPreferenceRevisions"] | undefined;
  const revisions = mergeRevisionMaps(leftRevisions, rightRevisions);
  return {
    ...left,
    ...right,
    legacyPreferencesMigrated: !!left.legacyPreferencesMigrated || !!right.legacyPreferencesMigrated,
    userPreferenceRevisions: revisions,
    agents: mergeAgentSnapshots(left.agents, right.agents, leftRevisions, rightRevisions),
  };
}

function mergeSerializedAgentData(existing: string | null, incoming: string): string {
  if (!existing) return incoming;
  try {
    const existingEnvelope = JSON.parse(existing) as { state?: Record<string, any>; version?: number };
    const incomingEnvelope = JSON.parse(incoming) as { state?: Record<string, any>; version?: number };
    if (!existingEnvelope.state || !incomingEnvelope.state) return incoming;
    const mergedState = mergePersistedAgentSlices(existingEnvelope.state, incomingEnvelope.state);
    return JSON.stringify({
      ...incomingEnvelope,
      state: persistedAgentDataState(mergedState as AgentDataStoreState),
    });
  } catch {
    return incoming;
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function persistedAgentDataState(state: AgentDataStoreState): Record<string, unknown> {
  return {
    legacyPreferencesMigrated: state.legacyPreferencesMigrated,
    userPreferenceRevisions: state.userPreferenceRevisions,
    agents: Object.fromEntries(AGENT_TYPES.map((agentType) => {
      const agent = state.agents[agentType];
      return [agentType, {
        catalog: {
          models: agent.catalog.models,
          skillsByNotebookId: agent.catalog.skillsByNotebookId,
        },
        user: agent.user,
      }];
    })),

  };
}

export const useAgentDataStore = create<AgentDataStoreState>()(
  persist(
    (set, get) => ({
      legacyPreferencesMigrated: false,
      userPreferenceRevisions: {},
      persistenceError: lastPersistenceError,
      agents: createInitialAgents(),
      loadState: { piMode: { status: "idle" } },

      initializePiMode: () => {
        if (pendingPiModeInitialization) return pendingPiModeInitialization;
        if (get().loadState.piMode.status === "ready") return Promise.resolve();
        set((state) => ({ loadState: { ...state.loadState, piMode: { status: "loading" } } }));
        const request = (async () => {
          if (get().agents.pi.user.mode === undefined) {
            const features = await piModels.getFeatures();
            // Another window may have migrated and cleared the old source already.
            await useAgentDataStore.persist.rehydrate();
            const importedMode = features.legacyCodeMode === undefined
              ? undefined : features.legacyCodeMode ? "code" : "writing";
            set((state) => {
              // A choice made during this read always wins over migration.
              const previous = state.agents.pi.user;
              if (previous.mode !== undefined) return {};
              const user = { ...previous, mode: importedMode ?? "writing" };
              const revisions = stampLegacyPreferenceFields(state.userPreferenceRevisions.pi ?? {}, previous, user);
              if (importedMode === undefined) revisions.mode = DEFAULT_PREFERENCE_REVISION;
              return {
                agents: { ...state.agents, pi: { ...state.agents.pi, user } },
                userPreferenceRevisions: {
                  ...state.userPreferenceRevisions,
                  pi: revisions,
                },
              };
            });
            // The persistence merge can retain a stronger choice from another window.
            await useAgentDataStore.persist.rehydrate();
          }
          // Remove the legacy source only after the migrated preference is durable.
          try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA) ?? "null");
            if (saved?.state?.agents?.pi?.user?.mode === get().agents.pi.user.mode) {
              await piModels.clearLegacyCodeMode();
            }
          } catch (error) {
            logger.warn("Pi legacy mode cleanup deferred", { error });
          }
          set((state) => ({ loadState: { ...state.loadState, piMode: { status: "ready" } } }));
        })().catch((error) => {
          set((state) => ({ loadState: { ...state.loadState, piMode: { status: "error", error: errorMessage(error) } } }));
          throw error;
        }).finally(() => { pendingPiModeInitialization = null; });
        pendingPiModeInitialization = request;
        return request;
      },

      initializeLegacySessionSettings: () => {
        if (get().legacyPreferencesMigrated) return Promise.resolve();
        if (pendingLegacySessionInitialization) return pendingLegacySessionInitialization;
        const request = (async () => {
          const { useAgentSessionStore } = await import('./agent-session-store');
          get().migrateLegacySessionSettings(
            useAgentSessionStore.getState().sessionMeta.settings,
          );
          try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA) ?? 'null');
            if (!saved?.state?.legacyPreferencesMigrated) {
              logger.warn('Agent preference migration has not reached durable storage');
            }
          } catch (error) {
            logger.warn('Agent preference migration persistence check failed', { error });
          }
        })().finally(() => { pendingLegacySessionInitialization = null; });
        pendingLegacySessionInitialization = request;
        return request;
      },

      setModelCatalog: (agentType, catalog) => set((state) => ({
        agents: {
          ...state.agents,
          [agentType]: {
            ...state.agents[agentType],
            catalog: { ...state.agents[agentType].catalog, models: catalog },
          },
        },
      })),

      invalidateModelCatalog: (agentType) => set((state) => ({
        agents: {
          ...state.agents,
          [agentType]: {
            ...state.agents[agentType],
            catalog: {
              ...state.agents[agentType].catalog,
              models: { ...state.agents[agentType].catalog.models, updatedAt: 0 },
            },
          },
        },
      })),

      invalidateSkillCatalog: (agentType, notebookId) => set((state) => {
        const current = state.agents[agentType].catalog.skillsByNotebookId[notebookId];
        if (!current) return state;
        return {
          agents: {
            ...state.agents,
            [agentType]: {
              ...state.agents[agentType],
              catalog: {
                ...state.agents[agentType].catalog,
                skillsByNotebookId: {
                  ...state.agents[agentType].catalog.skillsByNotebookId,
                  [notebookId]: { ...current, updatedAt: 0 },
                },
              },
            },
          },
        };
      }),

      loadModelCatalog: (agentType, loader, options) => {
        const cached = get().agents[agentType].catalog.models;
        const maxAgeMs = options?.maxAgeMs ?? MODEL_CATALOG_MAX_AGE_MS;
        const isFresh = !!cached.updatedAt && Date.now() - cached.updatedAt < maxAgeMs;
        if (!options?.force && isFresh) return Promise.resolve(cached);
        const pending = pendingModelLoads.get(agentType);
        if (pending) {
          if (!options?.force) return pending;
          return pending.catch(() => undefined).then(() => {
            const nextPending = pendingModelLoads.get(agentType);
            return nextPending ?? get().loadModelCatalog(agentType, loader, options);
          });
        }

        const request = loader()
          .then((catalog) => {
            const stored = { ...catalog, updatedAt: catalog.updatedAt ?? Date.now() };
            get().setModelCatalog(agentType, stored);
            return stored;
          })
          .finally(() => pendingModelLoads.delete(agentType));
        pendingModelLoads.set(agentType, request);
        return request;
      },

      setSkillCatalog: (agentType, notebookId, items) => set((state) => ({
        agents: {
          ...state.agents,
          [agentType]: {
            ...state.agents[agentType],
            catalog: {
              ...state.agents[agentType].catalog,
              skillsByNotebookId: {
                ...state.agents[agentType].catalog.skillsByNotebookId,
                [notebookId]: { items, updatedAt: Date.now() },
              },
            },
          },
        },
      })),

      loadSkillCatalog: (agentType, notebookId, loader, options) => {
        const cached = get().agents[agentType].catalog.skillsByNotebookId[notebookId];
        const maxAgeMs = options?.maxAgeMs ?? SKILL_CATALOG_MAX_AGE_MS;
        const isFresh = !!cached?.updatedAt && Date.now() - cached.updatedAt < maxAgeMs;
        if (!options?.force && isFresh) return Promise.resolve(cached.items);
        const key = skillLoadKey(agentType, notebookId);
        const pending = pendingSkillLoads.get(key);
        if (pending) {
          if (!options?.force) return pending;
          return pending.catch(() => undefined).then(() => {
            const nextPending = pendingSkillLoads.get(key);
            return nextPending ?? get().loadSkillCatalog(agentType, notebookId, loader, options);
          });
        }

        const request = loader()
          .then((items) => {
            get().setSkillCatalog(agentType, notebookId, items);
            return items;
          })
          .finally(() => pendingSkillLoads.delete(key));
        pendingSkillLoads.set(key, request);
        return request;
      },

      setUserPreference: (agentType, patch) => set((state) => {
        const previous = state.agents[agentType].user;
        const nextUser = { ...previous, ...patch };
        const revisions = stampChangedPreferenceFields(
          state.userPreferenceRevisions[agentType] ?? {}, previous, nextUser,
        );
        // Explicitly selecting an existing default/import is still a user choice.
        for (const field of Object.keys(patch)) {
          if (field !== "reasoningByModel" && (!revisions[field] || isImportedPreferenceRevision(revisions[field]))) {
            revisions[field] = nextPreferenceRevision();
          }
        }
        const userPreferenceRevisions = {
          ...state.userPreferenceRevisions,
          [agentType]: revisions,
        };
        return {
          agents: {
            ...state.agents,
            [agentType]: { ...state.agents[agentType], user: nextUser },
          },
          userPreferenceRevisions,
        };
      }),

      rememberModelReasoning: (agentType, model, effort) => {
        const current = get().agents[agentType].user;
        const reasoningByModel = { ...current.reasoningByModel };
        if (model) reasoningByModel[modelPreferenceKey(model)] = effort;
        get().setUserPreference(agentType, { reasoningEffort: effort, reasoningByModel });
      },

      migrateLegacySessionSettings: (codexSessionSettings) => {
        if (get().legacyPreferencesMigrated) return;
        if (!codexSessionSettings) {
          set({ legacyPreferencesMigrated: true });
          return;
        }
        set((state) => {
          const agents = { ...state.agents };
          const userPreferenceRevisions = { ...state.userPreferenceRevisions };
          const migrated: AgentUserPreference = {
            ...(codexSessionSettings.agentCodexModel && codexSessionSettings.agentCodexModel !== "inherit"
              ? { model: { id: codexSessionSettings.agentCodexModel } }
              : {}),
            ...(codexSessionSettings.agentPermissionMode
              ? { permission: codexSessionSettings.agentPermissionMode }
              : {}),
            ...(codexSessionSettings.agentCodexReasoningEffort
              ? {
                  reasoningEffort: codexSessionSettings.agentCodexReasoningEffort,
                  ...(codexSessionSettings.agentCodexModel && codexSessionSettings.agentCodexModel !== "inherit"
                    ? { reasoningByModel: {
                        [modelPreferenceKey({ id: codexSessionSettings.agentCodexModel })]: codexSessionSettings.agentCodexReasoningEffort,
                      } }
                    : {}),
                }
              : {}),
          };
          const previousUser = agents.codex.user;
          const nextUser = {
            ...migrated,
            ...previousUser,
            ...(migrated.reasoningByModel || previousUser.reasoningByModel
              ? { reasoningByModel: { ...migrated.reasoningByModel, ...previousUser.reasoningByModel } }
              : {}),
          };
          if (Object.keys(migrated).length) {
            userPreferenceRevisions.codex = stampLegacyPreferenceFields(
              userPreferenceRevisions.codex ?? {},
              previousUser,
              nextUser,
            );
            agents.codex = { ...agents.codex, user: nextUser };
          }
          return { agents, userPreferenceRevisions, legacyPreferencesMigrated: true };
        });
      },

    }),
    {
      name: STORAGE_KEYS.AGENT_DATA,
      version: 2,
      storage: createJSONStorage(() => agentStorage),
      partialize: persistedAgentDataState,
      migrate: (persisted) => mergePersistedAgentSlices({}, persisted as Record<string, any>),
      merge: (persisted, current) => {
        const stored = persisted as Partial<AgentDataStoreState>;
        const merged = mergePersistedAgentSlices(current as unknown as Record<string, any>, stored as Record<string, any>);
        const agents = merged.agents as Record<AgentTypeKey, AgentDataRecord>;
        for (const agentType of AGENT_TYPES) {
          agents[agentType] = {
            ...current.agents[agentType],
            ...agents[agentType],
            catalog: {
              ...current.agents[agentType].catalog,
              ...agents[agentType].catalog,
              capabilities: current.agents[agentType].catalog.capabilities,
            },
          };
        }
        return {
          ...current,
          agents,
          legacyPreferencesMigrated: !!merged.legacyPreferencesMigrated,
          userPreferenceRevisions: merged.userPreferenceRevisions,
        };
      },
    },
  ),
);

/** Resolve retained session settings and Pi mode before a runtime config is built. */
export async function ensureAgentPreferencesReady(agentType?: AgentTypeKey): Promise<void> {
  const state = useAgentDataStore.getState();
  await state.initializeLegacySessionSettings().catch((error) => {
    logger.warn("Agent session settings migration deferred", { error });
  });
  if (!agentType || agentType === "pi") {
    await state.initializePiMode();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(PERSISTENCE_STATUS_EVENT, (event) => {
    const error = (event as CustomEvent<{ error: string | null }>).detail?.error ?? null;
    if (useAgentDataStore.getState().persistenceError !== error) {
      useAgentDataStore.setState({ persistenceError: error });
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEYS.AGENT_DATA || event.key === null) {
      void Promise.resolve(useAgentDataStore.persist.rehydrate()).then(() => {
        const raw = agentStorage.getItem(STORAGE_KEYS.AGENT_DATA);
        if (!raw) return;
        try {
          const persisted = JSON.parse(raw) as { state?: Record<string, unknown> };
          const currentSnapshot = persistedAgentDataState(useAgentDataStore.getState());
          if (persisted.state && stableSerialize(currentSnapshot) !== stableSerialize(persisted.state)) {
            // Re-write the field-wise merge so simultaneous windows converge
            // even when both tabs wrote a stale whole-store snapshot.
            useAgentDataStore.setState((state) => ({ ...state }));
          }
        } catch (error) {
          logger.warn("Agent cache reconciliation failed", { error });
        }
      });
    }
  });
}
