export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type RpcRequest = {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Json
}

export type RpcResponse = {
  jsonrpc: '2.0'
  id: string | number
  result?: Json
  error?: { code: number; message: string; data?: Json }
}

export type RpcNotification = { jsonrpc: '2.0'; method: string; params?: Json }

export type RpcId = string | number

export type SubagentRef = {
  parentThreadId?: string
  childThreadId: string
  callId?: string
  itemId?: string
  clientMutationId?: string
  runId?: string
  turnId?: string
  agentPath?: string[]
  role?: string
  model?: string
  mode?: 'one-shot' | 'continuable'
  activity?: 'running' | 'inactive'
  hasChildren?: boolean
  prompt?: Json
  status: string
  agentStatus?: string
  completedSteps?: number
  result?: Json
  error?: string
}

export type Thread = {
  id: string
  parentThreadId?: string
  status: 'idle' | 'running' | 'closed'
  turns: Turn[]
  subagents?: SubagentRef[]
}

export type Turn = {
  id: string
  threadId: string
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  items: Item[]
  itemsView?: 'notLoaded' | 'summary' | 'full'
}

export type Item = {
  id: string
  threadId?: string
  turnId?: string
  type: 'userMessage' | 'agentMessage' | 'toolCall' | 'toolResult' | 'systemMessage' | 'collabAgentToolCall'
  status?: 'inProgress' | 'completed' | 'failed' | 'cancelled'
  revision?: number
  text?: string
  /** Product display classification for non-model timeline items. */
  messageType?: string
  sourceSeq?: number
  startedAt?: number | string
  completedAt?: number | string
  senderThreadId?: string
  receiverThreadIds?: string[]
  agentStates?: Record<string, Json>
  result?: Json
  error?: string
}

export type TurnPage = {
  data: Turn[]
  nextCursor: string | null
}

export type DshSkill = {
  name: string
  description: string
  displayName?: string
  path?: string
  scope?: 'user' | 'repo' | 'system' | 'admin' | 'workspace' | 'managed'
  enabled?: boolean
  userInvocable?: boolean
  pluginId?: string
  whenToUse?: string
  modelInvocable?: boolean
}

export type SkillCatalogEntry = {
  cwd: string
  skills: DshSkill[]
  errors: Array<{ path?: string; message: string }>
}

/** Wire-form image upload. The app-server admits it before appending a DSH event. */
export type DshImageAttachment = {
  type: 'image'
  mediaType: string
  data: string
  name?: string
}

export type DshCommandAttachment = DshImageAttachment | {
  type: 'file'
  receiptId: string
}

/** DSH-owned work that may continue after command/done. */
export type DshCommandEffects = {
  turn: 'none' | 'steer' | 'goal-round'
  followup?: boolean
}

export type DshCommandResult = {
  execution: Json
  effects?: DshCommandEffects
  export?: { filename: string; content: string }
}

export type ThreadLaunchConfig = {
  cwd?: string
  provider?: string
  model?: string
  maxTokens?: number
  agentPreset?: string
  permissionMode?: string
  parentThreadId?: string
  delegationDepth?: number
}

export interface ThreadPort {
  startThread(threadId: string, config?: ThreadLaunchConfig): Promise<Thread>
  resumeThread(threadId: string, config?: ThreadLaunchConfig): Promise<Thread>
  forkThread(sourceId: string, boundarySeq?: number, childId?: string): Promise<Thread>
  readThread(threadId: string, includeTurns: boolean): Promise<Thread>
  listThreads(): Promise<Thread[]>
  listTurns(threadId: string, cursor?: string, limit?: number): Promise<TurnPage>
  listEvents(threadId: string, afterSeq?: number, limit?: number): Promise<{ data: Json[]; nextCursor: string | null }>
  closeThread(threadId: string): Promise<{ closed: boolean }>
  archiveThread(threadId: string): Promise<{ archived: boolean }>
}

export interface TurnPort {
  startTurn(threadId: string, input: Json): Promise<Turn>
  steerTurn(threadId: string, input: Json, clientMessageId?: string): Promise<boolean>
  interruptTurn(threadId: string): Promise<{ interrupted: boolean }>
}

export interface CommandPort {
  executeCommand(threadId: string, command: string, attachments?: DshCommandAttachment[]): Promise<Json | DshCommandResult>
  listSkills(threadId: string): Promise<{ skills: DshSkill[] }>
}

export interface EventPort {
  subscribe(listener: (event: RpcNotification) => void): () => void
}

export interface CredentialPort {
  describeCredentials(reference: string): Json
  setCredential(reference: string, value: string): Promise<Json>
  unsetCredential(reference: string): Promise<Json>
}

export interface ModelAdminPort {
  describeModels(): Json
  catalogModels(): Promise<Json>
  discoverModels(request?: Json): Promise<Json>
  configureModel(route: string, profile: Json, expectedRevision?: number): Promise<Json>
  deleteModel(route: string, expectedRevision?: number): Promise<Json>
}

export interface ConfigPort {
  readConfig(namespace?: string): Json
  writeConfigValue(params: Json): Promise<Json>
  batchWriteConfig(params: Json): Promise<Json>
  readConfigRequirements(namespace?: string): Json
}

export type McpServerStatus = {
  name: string
  runtimeStatus: 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled' | null
  pluginId?: string | null
  serverInfo?: Json
  serverCapabilities?: Json
  tools: Record<string, Json>
  toolsError?: string | null
  resources: Json[]
  resourceTemplates: Json[]
  authStatus: string
}

export interface McpPort {
  listMcpServerStatus(params?: Json): Promise<{ data: McpServerStatus[]; nextCursor: string | null }>
  refreshMcpServers(): Promise<Json>
  reloadMcpConfig(): Promise<Json>
  loginMcpServer(params: Json): Promise<Json>
  callMcpTool(params: Json): Promise<Json>
  readMcpResource(params: Json): Promise<Json>
}

export interface SubagentPort {
  spawnSubagent(parentThreadId: string, request: Json): Promise<{ subagent: SubagentRef }>
  listSubagents(parentThreadId: string): Promise<{ data: SubagentRef[] }>
  sendSubagent(childThreadId: string, request: Json): Promise<Json>
  resumeSubagent(childThreadId: string): Promise<Json>
  interruptSubagent(childThreadId: string): Promise<Json>
  waitSubagent(childThreadId: string): Promise<Json>
  closeSubagent(childThreadId: string): Promise<Json>
}

export interface RuntimeInspectionPort {
  statusReport(): Json
  capabilitiesReport(): Json
  protocolCapabilities(): Json
}

/** Compatibility aggregate. New resource modules should depend on the narrow port they use. */
export interface HarnessAdapter extends ThreadPort, TurnPort, CommandPort, EventPort {}
