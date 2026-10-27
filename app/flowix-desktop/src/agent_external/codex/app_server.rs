//! Long-lived Codex app-server runtime.
//!
//! The app-server protocol is JSON-RPC over JSONL on stdio. A single server
//! owns many Codex threads and turns, so Flowix keeps the process connection
//! separately from the per-thread run registry.

mod history_projection;
mod tool_items;
use history_projection::*;
use tool_items::{
    codex_custom_tool_message_type, codex_tool_call_identity, codex_tool_call_input,
    codex_tool_result_identity, codex_tool_result_value, is_custom_tool_call_item,
};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex, OwnedMutexGuard};

use super::command::{build_codex_entrypoint, preflight_codex, resolve_codex_cwd};
use super::{parse_codex_version, AGENT_TYPE};
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata,
    select_external_session_for_runtime, AgentChunkMetadata, USER_STOPPED_REASON,
};
use crate::agent_session::{ChatMessage, ThreadInfo, ThreadManager, ThreadMessagesPage};
use crate::agent_types::AgentId;
use crate::agent_wire::{
    AgentChunk, AgentMessageAttachment, AgentRuntimeConfig, AgentUserMessage, RunInfo,
};

const INITIALIZE_METHOD: &str = "initialize";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const MAX_PENDING_TURN_NOTIFICATIONS: usize = 4096;
const CONTEXT_COMPACTION_MESSAGE_TYPE: &str = "context-compaction";
const CODEX_COMMAND_MESSAGE_TYPE: &str = "codex-command";
const CODEX_COMMENTARY_MESSAGE_TYPE: &str = "agent-commentary";
const CODEX_MISSING_USER_ITEM_ID: &str = "flowix:codex:missing-user-item";
const MIN_PAGINATED_CODEX_VERSION: &str = "0.150.0";

fn codex_turn_error_message_id(turn_id: &str) -> String {
    format!("msg:codex:turn-error:{turn_id}")
}

fn codex_command_message_id(turn_id: Option<&str>, source_id: &str) -> String {
    match turn_id.filter(|id| !id.trim().is_empty()) {
        Some(turn_id) => format!("flowix:codex:command:{turn_id}"),
        // History has no shared turn key for older records that omit turn IDs.
        None => format!("flowix:codex:command:unbound:{source_id}"),
    }
}

fn codex_tool_call_message_id(turn_id: Option<&str>, call_id: &str) -> String {
    format!(
        "flowix:codex:tool-call:{}:{call_id}",
        turn_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("unbound")
    )
}

fn codex_custom_tool_output_message_id(turn_id: Option<&str>, call_id: &str) -> String {
    format!(
        "flowix:codex:tool-output:{}:{call_id}",
        turn_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("unbound")
    )
}

fn codex_fallback_item_message_id(
    turn_id: &str,
    role: &str,
    content: &str,
    occurrence: usize,
) -> String {
    let mut first = 0x811c_9dc5_u32;
    let mut second = 0x9e37_79b9_u32;
    for byte in content.as_bytes() {
        first = (first ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
        second = (second ^ u32::from(*byte)).wrapping_mul(0x85eb_ca6b);
    }
    format!("flowix:codex:item:{turn_id}:{role}:{first:08x}{second:08x}:{occurrence}")
}

fn codex_turn_error_metadata(turn_id: Option<&str>) -> AgentChunkMetadata {
    let Some(turn_id) = turn_id.filter(|id| !id.trim().is_empty()) else {
        return AgentChunkMetadata::default();
    };
    AgentChunkMetadata {
        codex_turn_id: Some(turn_id.to_string()),
        message_id: Some(codex_turn_error_message_id(turn_id)),
        ..AgentChunkMetadata::default()
    }
}

fn is_stale_queued_submission_error(error: &str) -> bool {
    error
        .to_ascii_lowercase()
        .contains("queued submission not found")
}

fn is_queue_start_conflict_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    is_stale_queued_submission_error(&error)
        || error.contains("thread already has an active or pending turn")
        || error.contains("codex already has an active turn")
}

fn codex_user_input(message: &AgentUserMessage) -> Vec<Value> {
    let mut input = vec![json!({
        "type": "text",
        "text": message.llm_content.clone().unwrap_or_else(|| message.content.clone()),
    })];
    input.extend(
        message
            .image_paths
            .iter()
            .filter(|path| std::path::Path::new(path).is_file())
            .filter(|path| is_image_attachment(path))
            .map(|path| json!({ "type": "localImage", "path": path })),
    );
    let attached_files = message
        .image_paths
        .iter()
        .filter(|path| std::path::Path::new(path).is_file())
        .filter(|path| !is_image_attachment(path))
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>();
    if !attached_files.is_empty() {
        input.push(json!({
            "type": "text",
            "text": format!("\n<attached_files>\n{}\n</attached_files>", attached_files.join("\n")),
        }));
    }
    input
}

fn is_image_attachment(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif")
    )
}

struct Connection {
    _child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    generation: u64,
}

#[derive(Clone)]
struct ActiveTurn {
    flowix_thread_id: String,
    run_id: String,
    /// Present when Codex started this turn directly from its Follow-up queue.
    client_user_message_id: Option<String>,
    codex_thread_id: String,
    codex_turn_id: String,
    binding: TurnBinding,
    /// Turn-scoped notifications can beat the `turn/start` response. Ordinary
    /// chats keep them here until that response supplies the authoritative id.
    pending_notifications: Vec<Value>,
    dropped_notifications: u64,
    turn_ready: Arc<tokio::sync::Notify>,
    /// The UI can stop a native command before Codex announces its provider
    /// turn. Keep the registry entry until that turn id arrives so the
    /// notification path can interrupt the real provider work.
    cancel_requested: bool,
    stopping: bool,
    /// Present only for a Codex-native slash command. `/compact` and goal
    /// mutations keep this active until the provider's follow-up turn ends.
    command_id: Option<String>,
    command: Option<String>,
    app_handle: tauri::AppHandle,
    started_at: i64,
    last_event_at: i64,
    stream_end_emitted: Arc<AtomicBool>,
    /// Completed agent item snapshots can be present both in
    /// `item/completed` and in the terminal turn payload. Keep the snapshots
    /// per active turn so the terminal payload remains a true fallback
    /// instead of a second delivery.
    completed_agent_messages: Arc<Mutex<Vec<SeenCompletedAgentMessage>>>,
    /// Runtime-owned receipts survive webview reloads until userMessage consumption.
    pending_steers: Vec<Value>,
}

#[derive(Clone)]
struct QueuedCodexFollowUp {
    flowix_thread_id: String,
    codex_thread_id: String,
    queued_submission_id: Option<String>,
    client_user_message_id: String,
    message: AgentUserMessage,
    run_id: String,
}

struct CompletedAgentMessageCandidate {
    id: Option<String>,
    text: String,
}

struct SeenCompletedAgentMessage {
    id: Option<String>,
    text: String,
    fallback_occurrence: Option<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TurnBinding {
    /// An ordinary chat is bound only by its own `turn/start` response.
    StartResponse,
    /// Native asynchronous commands do not always return a turn id and must
    /// bind from their first `turn/started` notification.
    StartedNotification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UnboundNotificationAction {
    Buffer,
    Bind,
    Ignore,
}

fn unbound_notification_action(
    binding: TurnBinding,
    method: &str,
    has_thread_and_turn: bool,
) -> UnboundNotificationAction {
    if !has_thread_and_turn || !turn_scoped_notification(method) {
        return UnboundNotificationAction::Ignore;
    }
    match binding {
        TurnBinding::StartResponse => UnboundNotificationAction::Buffer,
        TurnBinding::StartedNotification if method == "turn/started" => {
            UnboundNotificationAction::Bind
        }
        TurnBinding::StartedNotification => UnboundNotificationAction::Buffer,
    }
}

fn buffer_turn_notification(active: &mut ActiveTurn, message: &Value) {
    if active.pending_notifications.len() == MAX_PENDING_TURN_NOTIFICATIONS {
        active.dropped_notifications = active.dropped_notifications.saturating_add(1);
        if active.dropped_notifications.is_power_of_two() {
            tracing::warn!(
                thread_id = %active.flowix_thread_id,
                run_id = %active.run_id,
                dropped = active.dropped_notifications,
                limit = MAX_PENDING_TURN_NOTIFICATIONS,
                "Codex startup notification buffer overflow; oldest notifications dropped"
            );
        }
        active.pending_notifications.remove(0);
    }
    active.pending_notifications.push(message.clone());
}

/// Called under active_turns when registering ordinary work, so Stop cannot
/// fall between publishing a cancellation and registering the active turn.
fn take_pending_cancellation(
    pending: &mut HashMap<String, String>,
    thread_id: &str,
    run_id: &str,
) -> bool {
    pending
        .remove(thread_id)
        .is_some_and(|expected| expected == run_id)
}

struct Inner {
    thread_manager: Arc<ThreadManager>,
    connection: Mutex<Option<Connection>>,
    // Serialize the first connection attempt. `ensure_connection` is called
    // by thread, history, and model APIs and those calls can arrive
    // concurrently during startup; checking `connection` alone is not enough
    // to prevent spawning one app-server per caller.
    connection_start_lock: Mutex<()>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    pending_approvals: Mutex<Vec<CodexApprovalRequest>>,
    /// Stop may arrive after the web projection is marked pending but before
    /// the slash-command task has registered its ActiveTurn. Scope the
    /// cancellation to the command run id so an unrelated future command is
    /// not cancelled accidentally.
    pending_cancellations: Mutex<HashMap<String, String>>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    /// Flowix queue entries awaiting Codex's automatic post-turn start.
    /// Codex owns the actual queue; this map only binds its next turn to the
    /// matching Flowix run and optimistic user message.
    queued_follow_ups: Mutex<HashMap<String, Vec<QueuedCodexFollowUp>>>,
    /// Serialize queue mutations and delivery decisions per Flowix thread,
    /// including calls from separate webviews.
    follow_up_operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Keep notification routing and buffered-event replay in one total order.
    notification_dispatch: Mutex<()>,
    latest_usage: Mutex<HashMap<String, crate::agent_types::UsageInfo>>,
    next_request_id: AtomicU64,
    next_connection_generation: AtomicU64,
}

pub struct CodexAppServerManager {
    inner: Arc<Inner>,
}

fn queued_follow_up_from_submission(
    flowix_thread_id: &str,
    codex_thread_id: &str,
    submission: &Value,
) -> Option<QueuedCodexFollowUp> {
    let client_user_message_id = submission
        .get("clientUserMessageId")
        .and_then(Value::as_str)?
        .to_string();
    let queued_submission_id = submission
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let input = submission.get("input").and_then(Value::as_array)?;
    let texts = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let content = texts.join("\n");
    let image_paths = input
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("localImage"))
        .filter_map(|item| item.get("path").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let run_id = crate::agent_external::resolve_run_id(flowix_thread_id, None);
    Some(QueuedCodexFollowUp {
        flowix_thread_id: flowix_thread_id.to_string(),
        codex_thread_id: codex_thread_id.to_string(),
        queued_submission_id,
        client_user_message_id,
        message: AgentUserMessage {
            content: content.clone(),
            llm_content: Some(content),
            image_paths,
            run_id: Some(run_id.clone()),
            system_reminder_directory: None,
            agent_type: Some(AGENT_TYPE.to_string()),
            runtime_config: None,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        },
        run_id,
    })
}

fn queued_follow_up_at_queue_head(
    flowix_thread_id: &str,
    codex_thread_id: &str,
    queue: &Value,
) -> Option<QueuedCodexFollowUp> {
    queue
        .get("data")
        .and_then(Value::as_array)
        .and_then(|submissions| submissions.first())
        .and_then(|submission| {
            queued_follow_up_from_submission(flowix_thread_id, codex_thread_id, submission)
        })
}

fn order_queued_follow_ups(items: &mut Vec<QueuedCodexFollowUp>, provider_order: &[String]) {
    let positions = provider_order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut indexed = items.drain(..).enumerate().collect::<Vec<_>>();
    indexed.sort_by_key(|(original_index, item)| {
        match item
            .queued_submission_id
            .as_deref()
            .and_then(|id| positions.get(id).copied())
        {
            Some(provider_index) => (1, provider_index, *original_index),
            // An item missing from the provider queue may already have been
            // consumed and still be waiting for its `turn/started` event.
            // Keep those candidates before the live queue, in their prior
            // order, so that event can still claim the correct run.
            None if item.queued_submission_id.is_some() => (0, *original_index, 0),
            None => (2, *original_index, 0),
        }
    });
    items.extend(indexed.into_iter().map(|(_, item)| item));
}

async fn remember_queued_follow_ups(
    inner: &Arc<Inner>,
    flowix_thread_id: &str,
    codex_thread_id: &str,
    queue: &Value,
) {
    let Some(submissions) = queue.get("data").and_then(Value::as_array) else {
        return;
    };
    let mut provider_order = Vec::new();
    for submission in submissions {
        if let Some(id) = submission.get("id").and_then(Value::as_str) {
            provider_order.push(id.to_string());
        }
        if let Some(queued) =
            queued_follow_up_from_submission(flowix_thread_id, codex_thread_id, submission)
        {
            upsert_queued_follow_up(inner, queued).await;
        }
    }
    if let Some(items) = inner
        .queued_follow_ups
        .lock()
        .await
        .get_mut(codex_thread_id)
    {
        order_queued_follow_ups(items, &provider_order);
    }
}

async fn upsert_queued_follow_up(inner: &Arc<Inner>, queued: QueuedCodexFollowUp) {
    let mut by_thread = inner.queued_follow_ups.lock().await;
    let items = by_thread.entry(queued.codex_thread_id.clone()).or_default();
    if let Some(existing) = items.iter_mut().find(|item| {
        item.client_user_message_id == queued.client_user_message_id
            || (queued.queued_submission_id.is_some()
                && item.queued_submission_id == queued.queued_submission_id)
    }) {
        if existing.queued_submission_id.is_none() {
            existing.queued_submission_id = queued.queued_submission_id;
        }
        return;
    }
    items.push(queued);
}

async fn remove_queued_follow_up(
    inner: &Arc<Inner>,
    codex_thread_id: &str,
    queued_submission_id: Option<&str>,
    client_user_message_id: Option<&str>,
) {
    let mut by_thread = inner.queued_follow_ups.lock().await;
    let Some(items) = by_thread.get_mut(codex_thread_id) else {
        return;
    };
    items.retain(|item| {
        !(queued_submission_id.is_some_and(|id| item.queued_submission_id.as_deref() == Some(id))
            || client_user_message_id.is_some_and(|id| item.client_user_message_id == id))
    });
    if items.is_empty() {
        by_thread.remove(codex_thread_id);
    }
}

async fn lock_follow_up_operations(
    inner: &Arc<Inner>,
    flowix_thread_id: &str,
) -> OwnedMutexGuard<()> {
    let lock = {
        let mut locks = inner.follow_up_operation_locks.lock().await;
        locks
            .entry(flowix_thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    lock.lock_owned().await
}

async fn bind_automatically_started_queue_turn(
    inner: &Arc<Inner>,
    codex_thread_id: &str,
    codex_turn_id: &str,
) {
    let app_handle = inner.app_handle.lock().await.clone();
    let Some(app_handle) = app_handle else {
        return;
    };
    let queued = {
        let mut by_thread = inner.queued_follow_ups.lock().await;
        let Some(items) = by_thread.get_mut(codex_thread_id) else {
            return;
        };
        if items.is_empty() {
            return;
        }
        let queued = items.remove(0);
        if items.is_empty() {
            by_thread.remove(codex_thread_id);
        }
        queued
    };
    let started_at = chrono::Utc::now().timestamp_millis();
    let stream_end_emitted = Arc::new(AtomicBool::new(false));
    let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));
    {
        let mut active_turns = inner.active_turns.lock().await;
        if active_turns
            .values()
            .any(|active| active.codex_thread_id == codex_thread_id)
        {
            drop(active_turns);
            // A separately tracked run already owns this provider thread.
            // Put the queue record back so the next matching start can claim it.
            inner
                .queued_follow_ups
                .lock()
                .await
                .entry(codex_thread_id.to_string())
                .or_default()
                .insert(0, queued);
            return;
        }
        active_turns.insert(
            queued.flowix_thread_id.clone(),
            ActiveTurn {
                flowix_thread_id: queued.flowix_thread_id.clone(),
                run_id: queued.run_id.clone(),
                client_user_message_id: Some(queued.client_user_message_id.clone()),
                codex_thread_id: codex_thread_id.to_string(),
                codex_turn_id: codex_turn_id.to_string(),
                binding: TurnBinding::StartedNotification,
                pending_notifications: Vec::new(),
                dropped_notifications: 0,
                turn_ready: Arc::new(tokio::sync::Notify::new()),
                cancel_requested: false,
                stopping: false,
                command_id: None,
                command: None,
                app_handle: app_handle.clone(),
                started_at,
                last_event_at: started_at,
                stream_end_emitted: stream_end_emitted.clone(),
                completed_agent_messages: completed_agent_messages.clone(),
                pending_steers: Vec::new(),
            },
        );
    }
    let manager = CodexAppServerManager {
        inner: inner.clone(),
    };
    manager
        .emit_stream_start(
            &app_handle,
            &queued.flowix_thread_id,
            &queued.message,
            &queued.run_id,
        )
        .await;
}

impl CodexAppServerManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            inner: Arc::new(Inner {
                thread_manager,
                connection: Mutex::new(None),
                connection_start_lock: Mutex::new(()),
                pending: Mutex::new(HashMap::new()),
                pending_approvals: Mutex::new(Vec::new()),
                pending_cancellations: Mutex::new(HashMap::new()),
                app_handle: Mutex::new(None),
                active_turns: Mutex::new(HashMap::new()),
                queued_follow_ups: Mutex::new(HashMap::new()),
                follow_up_operation_locks: Mutex::new(HashMap::new()),
                notification_dispatch: Mutex::new(()),
                latest_usage: Mutex::new(HashMap::new()),
                next_request_id: AtomicU64::new(1),
                next_connection_generation: AtomicU64::new(1),
            }),
        }
    }

    async fn ensure_connection(&self) -> Result<(), String> {
        // Hold the startup lock through initialization so other callers never
        // reuse a connection before the handshake has completed.
        let _startup = self.inner.connection_start_lock.lock().await;
        if self.inner.connection.lock().await.is_some() {
            return Ok(());
        }

        preflight_codex()?;
        verify_paginated_codex_version().await?;
        let mut command = build_codex_entrypoint();
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process_window::hide_command_window(&mut command);
        crate::agent_external::shared::configure_unix_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Codex app-server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        tracing::debug!("[CodexAppServer] stderr: {line}");
                    }
                }
            });
        }

        let stdin = Arc::new(Mutex::new(stdin));
        let generation = self
            .inner
            .next_connection_generation
            .fetch_add(1, Ordering::Relaxed);
        *self.inner.connection.lock().await = Some(Connection {
            _child: child,
            stdin: stdin.clone(),
            generation,
        });
        let reader_inner = self.inner.clone();
        tokio::spawn(async move {
            read_loop(reader_inner, stdin, BufReader::new(stdout), generation).await;
        });

        let initialized = self
            .request(
                INITIALIZE_METHOD,
                json!({
                    "clientInfo": {
                        "name": "flowix",
                        "title": "Flowix",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await;
        let initialized = match initialized {
            Ok(_) => self.notify("initialized", json!({})).await,
            Err(error) => Err(error),
        };
        if initialized.is_err() {
            close_connection(&self.inner, generation).await;
        }
        initialized
    }

    async fn write(&self, message: Value) -> Result<(), String> {
        write_inner(&self.inner, message).await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        request_inner(&self.inner, method, params).await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({ "method": method, "params": params }))
            .await
    }

    async fn request_all_pages(&self, method: &str, params: Value) -> Result<Value, String> {
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        let mut data = Vec::new();
        const MAX_PAGES: usize = 100;
        for _ in 0..MAX_PAGES {
            let mut page_params = params.clone();
            if let Some(object) = page_params.as_object_mut() {
                object.insert("cursor".to_string(), json!(cursor));
            }
            let page = self.request(method, page_params).await?;
            data.extend(
                page.get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            let Some(next_cursor) = cursor.as_ref() else {
                return Ok(json!({ "data": data }));
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return Err(format!(
                    "Codex app-server returned a repeated cursor for {method}"
                ));
            }
        }
        Err(format!(
            "Codex app-server pagination exceeded {MAX_PAGES} pages for {method}"
        ))
    }

    /// Read skills independently of model, plugin and MCP discovery.
    pub async fn project_skills(
        &self,
        cwd: &std::path::Path,
        force_reload: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request(
            "skills/list",
            json!({ "cwds": [cwd.to_string_lossy()], "forceReload": force_reload }),
        )
        .await
    }

    /// Read the Codex capabilities that are effective for one project root.
    /// This is a metadata-only operation: it does not create a thread or spend
    /// model tokens. Keep the cwd explicit so project-local config and skills
    /// cannot leak across notebooks in the preferences UI.
    pub async fn project_capabilities(
        &self,
        cwd: &std::path::Path,
        force_reload: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let cwd = cwd.to_string_lossy().to_string();

        let (
            skills,
            config,
            requirements,
            models,
            mcp,
            plugins,
            plugin_catalog,
            agents,
            experiments,
        ) = tokio::join!(
            self.request(
                "skills/list",
                json!({ "cwds": [cwd.clone()], "forceReload": force_reload }),
            ),
            self.request("config/read", json!({ "cwd": cwd.clone() })),
            self.request("configRequirements/read", json!({})),
            self.request_all_pages("model/list", json!({ "limit": 100 })),
            self.request_all_pages(
                "mcpServerStatus/list",
                json!({ "limit": 100, "detail": "full" }),
            ),
            self.request("plugin/installed", json!({ "cwds": [cwd.clone()] }),),
            self.request(
                "plugin/list",
                json!({ "cwds": [cwd.clone()], "forceRefetch": force_reload }),
            ),
            // Descendant threads are Codex's durable representation of
            // spawned sub-agents. Filtering by cwd keeps this repo-scoped.
            self.request_all_pages(
                "thread/list",
                json!({
                    "cwd": cwd.clone(),
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "sourceKinds": [
                        "subAgent",
                        "subAgentReview",
                        "subAgentCompact",
                        "subAgentThreadSpawn",
                        "subAgentOther"
                    ]
                }),
            ),
            self.request_all_pages("experimentalFeature/list", json!({ "limit": 100 })),
        );

        fn result_or_error(result: Result<Value, String>) -> Value {
            match result {
                Ok(value) => json!({ "ok": true, "value": value }),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }

        Ok(json!({
            "cwd": cwd,
            "skills": result_or_error(skills),
            "config": result_or_error(config),
            "requirements": result_or_error(requirements),
            "models": result_or_error(models),
            "mcp": result_or_error(mcp),
            "plugins": result_or_error(plugins),
            "pluginCatalog": result_or_error(plugin_catalog),
            "agents": result_or_error(agents),
            "experiments": result_or_error(experiments),
            "projectConfigPath": std::path::Path::new(&cwd).join(".codex").join("config.toml"),
            "refreshedAt": chrono::Utc::now().timestamp_millis(),
        }))
    }

    pub async fn write_project_config(
        &self,
        cwd: &std::path::Path,
        edits: Value,
        expected_version: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let edits = edits
            .as_array()
            .ok_or_else(|| "config edits must be an array".to_string())?;
        if edits.is_empty() || edits.len() > 20 {
            return Err("config write requires between 1 and 20 edits".to_string());
        }
        const ALLOWED_KEYS: &[&str] = &[
            "model",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "model_verbosity",
            "review_model",
            "service_tier",
            "approval_policy",
            "approvals_reviewer",
            "sandbox_mode",
            "sandbox_workspace_write.network_access",
            "web_search",
            "instructions",
            "developer_instructions",
        ];
        for edit in edits {
            let key = edit
                .get("keyPath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !ALLOWED_KEYS.contains(&key) {
                return Err(format!("Codex setting is not editable from Flowix: {key}"));
            }
            if edit.get("mergeStrategy").and_then(Value::as_str) != Some("replace") {
                return Err("Codex settings UI only supports replace writes".to_string());
            }
            let value = edit.get("value").unwrap_or(&Value::Null);
            let valid = match key {
                "sandbox_workspace_write.network_access" => value.is_boolean(),
                "model_reasoning_effort" => {
                    matches!(
                        value.as_str(),
                        Some("low" | "medium" | "high" | "xhigh" | "max" | "ultra")
                    )
                }
                "model_verbosity" => matches!(value.as_str(), Some("low" | "medium" | "high")),
                "service_tier" => matches!(
                    value.as_str(),
                    Some("auto" | "default" | "flex" | "priority")
                ),
                "approval_policy" => matches!(
                    value.as_str(),
                    Some("untrusted" | "on-failure" | "on-request" | "never")
                ),
                "approvals_reviewer" => matches!(value.as_str(), Some("user" | "auto_review")),
                "sandbox_mode" => matches!(
                    value.as_str(),
                    Some("read-only" | "workspace-write" | "danger-full-access")
                ),
                "web_search" => matches!(
                    value.as_str(),
                    Some("disabled" | "cached" | "indexed" | "live")
                ),
                "instructions" | "developer_instructions" => {
                    value.as_str().is_some_and(|text| text.len() <= 50_000)
                }
                _ => value
                    .as_str()
                    .is_some_and(|text| !text.is_empty() && text.len() <= 200),
            };
            if !valid {
                return Err(format!("Invalid value for Codex setting: {key}"));
            }
        }
        let dot_codex = cwd.join(".codex");
        std::fs::create_dir_all(&dot_codex)
            .map_err(|error| format!("failed to create project Codex config folder: {error}"))?;
        if !crate::config::path_is_inside(&dot_codex, cwd) {
            return Err("project Codex config folder resolves outside the notebook".to_string());
        }
        self.request(
            "config/batchWrite",
            json!({
                "filePath": dot_codex.join("config.toml"),
                "expectedVersion": expected_version,
                "edits": edits,
                "reloadUserConfig": true
            }),
        )
        .await
    }

    pub async fn set_skill_enabled(&self, name: &str, enabled: bool) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request(
            "skills/config/write",
            json!({ "name": name, "enabled": enabled }),
        )
        .await
    }

    pub async fn set_plugin_installed(
        &self,
        plugin_id: &str,
        installed: bool,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        let (method, params) = if installed {
            ("plugin/install", json!({ "pluginName": plugin_id }))
        } else {
            ("plugin/uninstall", json!({ "pluginId": plugin_id }))
        };
        self.request(method, params).await
    }

    pub async fn reload_mcp_servers(&self) -> Result<Value, String> {
        self.ensure_connection().await?;
        self.request("config/mcpServer/reload", json!({})).await
    }

    pub async fn upsert_project_mcp(
        &self,
        cwd: &std::path::Path,
        name: &str,
        definition: Value,
        expected_version: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_connection().await?;
        if name.is_empty()
            || name.len() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err("MCP name may only contain letters, numbers, '-' and '_'".to_string());
        }
        let definition = definition
            .as_object()
            .ok_or_else(|| "MCP definition must be an object".to_string())?;
        if definition
            .keys()
            .any(|key| !matches!(key.as_str(), "command" | "args" | "url" | "enabled"))
        {
            return Err("MCP definition contains unsupported fields".to_string());
        }
        let has_command = definition
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty());
        let has_url = definition
            .get("url")
            .and_then(Value::as_str)
            .is_some_and(|v| v.starts_with("http://") || v.starts_with("https://"));
        if has_command == has_url {
            return Err("MCP definition must contain either command or http(s) url".to_string());
        }
        if definition
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|v| v.len() > 4_096)
            || definition
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|v| v.len() > 2_048)
            || definition.get("enabled").is_some_and(|v| !v.is_boolean())
        {
            return Err("MCP definition contains an invalid value".to_string());
        }
        if let Some(args) = definition.get("args") {
            let args = args
                .as_array()
                .ok_or_else(|| "MCP args must be an array".to_string())?;
            if args.len() > 100
                || args
                    .iter()
                    .any(|arg| arg.as_str().map_or(true, |v| v.len() > 4_096))
            {
                return Err("MCP args exceed the allowed size".to_string());
            }
        }
        let dot_codex = cwd.join(".codex");
        std::fs::create_dir_all(&dot_codex)
            .map_err(|e| format!("failed to create project Codex config folder: {e}"))?;
        if !crate::config::path_is_inside(&dot_codex, cwd) {
            return Err("project Codex config folder resolves outside the notebook".to_string());
        }
        let result = self.request("config/batchWrite", json!({
            "filePath": dot_codex.join("config.toml"),
            "expectedVersion": expected_version,
            "edits": [{ "keyPath": format!("mcp_servers.{name}"), "value": definition, "mergeStrategy": "replace" }],
            "reloadUserConfig": true
        })).await?;
        self.request("config/mcpServer/reload", json!({})).await?;
        Ok(result)
    }

    async fn resolve_codex_thread(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<(String, PathBuf), String> {
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let session_id = select_external_session_for_runtime(stored, None);
        let cwd = self
            .resolve_codex_cwd_for_next_turn(flowix_thread_id, message)
            .await?;
        if let Some(codex_thread_id) = session_id {
            self.request("thread/resume", json!({ "threadId": codex_thread_id }))
                .await?;
            return Ok((codex_thread_id, cwd));
        }

        // Writable threads use the interactive server-request approval path;
        // unsupported server requests remain fail-closed in read_loop.
        let approval = app_server_approval_policy(message.permission_mode_for_runtime(AGENT_TYPE));
        let workspace_roots = message.workspace_paths_for_runtime(AGENT_TYPE);
        let result = self
            .request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": message.codex_model_for_runtime(),
                    // `thread/start` still uses the legacy string field.
                    // The object-form `sandboxPolicy` is for turn/start and
                    // thread/settings/update; passing it here is accepted by
                    // some server versions but silently leaves the thread
                    // read-only.
                    "sandbox": app_server_legacy_sandbox(message.permission_mode_for_runtime(AGENT_TYPE)),
                    "approvalPolicy": approval,
                    "approvalsReviewer": "user",
                    // Persist the paginated transcript so thread/read and
                    // thread/turns/list can return command/tool items after
                    // the live stream has completed. Without this, Codex
                    // still emits item/* notifications but the legacy
                    // history view drops those items on reload.
                    "historyMode": "paginated",
                    "runtimeWorkspaceRoots": workspace_roots,
                    "serviceName": "flowix"
                }),
            )
            .await?;
        let codex_thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Codex app-server did not return a thread id".to_string())?
            .to_string();
        self.inner
            .thread_manager
            .upsert_external_session(flowix_thread_id, AGENT_TYPE, &codex_thread_id, Some(result))
            .await
            .map_err(|error| error.to_string())?;
        Ok((codex_thread_id, cwd))
    }

    /// `turn/start` accepts `cwd`, so Codex can deliberately apply a workspace
    /// selection made while a previous turn was running. Keep Flowix's stored
    /// cwd in sync for session metadata, but do not let that historical value
    /// override the directory selected for this next turn.
    async fn resolve_codex_cwd_for_next_turn(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<PathBuf, String> {
        let cwd = resolve_codex_cwd(message, None).ok_or_else(|| {
            "Agent working directory unavailable; open a notebook or pick a folder".to_string()
        })?;
        if self
            .inner
            .thread_manager
            .read_frozen_cwd(flowix_thread_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&cwd)
        {
            if let Err(error) = self
                .inner
                .thread_manager
                .upsert_frozen_cwd(flowix_thread_id, &cwd)
                .await
            {
                tracing::warn!(
                    "failed to persist Codex working directory for {flowix_thread_id}: {error}"
                );
            }
        }
        Ok(cwd)
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        self.ensure_connection().await?;
        let flowix_thread_id = flowix_thread_id.to_string();
        let run_id = message
            .run_id
            .clone()
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(&flowix_thread_id, None));
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(&flowix_thread_id)
        {
            return Err("Codex already has an active turn for this thread".to_string());
        }
        // The web projection inserts the user row optimistically before this
        // request reaches the runtime. Codex's own userMessage item is the
        // acknowledgement/history source; emitting another synthetic user
        // event here creates a second visible row and has no provider id.
        self.emit_stream_start(app_handle, &flowix_thread_id, &message, &run_id)
            .await;

        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));
        let started = async {
            let (codex_thread_id, cwd) = self.resolve_codex_thread(&flowix_thread_id, &message).await?;
            let approval = app_server_approval_policy(message.permission_mode_for_runtime(AGENT_TYPE));
            let workspace_roots = message.workspace_paths_for_runtime(AGENT_TYPE);
            let sandbox = app_server_sandbox_with_roots(
                message.permission_mode_for_runtime(AGENT_TYPE),
                &workspace_roots,
            );
            let mut input = vec![json!({ "type": "text", "text": message.llm_content.clone().unwrap_or_else(|| message.content.clone()) })];
            let mut attached_files = Vec::new();
            for path in message.image_paths.iter().filter(|path| std::path::Path::new(path).is_file()) {
                if is_image_attachment(path) {
                    input.push(json!({ "type": "localImage", "path": path }));
                } else {
                    attached_files.push(path.as_str());
                }
            }
            if !attached_files.is_empty() {
                let paths = attached_files.iter().map(|path| format!("- {path}")).collect::<Vec<_>>().join("\n");
                input.push(json!({ "type": "text", "text": format!("\n<attached_files>\n{paths}\n</attached_files>") }));
            }
            // App Server notifications are allowed to arrive before the
            // `turn/start` response. Register the run before sending the RPC
            // so the real `item/completed(userMessage)` acknowledgement is not
            // dropped during that window. `turn/started` (or the RPC result)
            // fills in the concrete turn id below.
            let cancelled_before_start = {
                let mut turns = self.inner.active_turns.lock().await;
                let cancelled = take_pending_cancellation(
                    &mut *self.inner.pending_cancellations.lock().await,
                    &flowix_thread_id,
                    &run_id,
                );
                if !cancelled {
                    turns.insert(flowix_thread_id.clone(), ActiveTurn {
                        flowix_thread_id: flowix_thread_id.clone(),
                        run_id: run_id.clone(),
                        client_user_message_id: None,
                        codex_thread_id: codex_thread_id.clone(),
                        codex_turn_id: String::new(),
                        binding: TurnBinding::StartResponse,
                        pending_notifications: Vec::new(),
                        dropped_notifications: 0,
                        turn_ready: Arc::new(tokio::sync::Notify::new()),
                        cancel_requested: false,
                        stopping: false,
                        command_id: None,
                        command: None,
                        app_handle: app_handle.clone(),
                        started_at: chrono::Utc::now().timestamp_millis(),
                        last_event_at: chrono::Utc::now().timestamp_millis(),
                        stream_end_emitted: stream_end_emitted.clone(),
                        completed_agent_messages: completed_agent_messages.clone(),
                        pending_steers: Vec::new(),
                    });
                }
                cancelled
            };
            if cancelled_before_start {
                self.emit_stream_end(
                    app_handle,
                    &flowix_thread_id,
                    &run_id,
                    Some(USER_STOPPED_REASON.to_string()),
                    &stream_end_emitted,
                ).await;
                return Ok(());
            }
            let mut turn_params = json!({
                "threadId": codex_thread_id,
                "input": input,
                "cwd": cwd,
                "model": message.codex_model_for_runtime(),
                "effort": message.codex_reasoning_effort_for_runtime(),
                "approvalPolicy": approval,
                "sandboxPolicy": sandbox
            });
            if let Some(service_tier) = message.codex_service_tier_for_runtime() {
                turn_params["serviceTier"] = json!(service_tier);
            }
            let result = self.request("turn/start", turn_params).await?;
            let codex_turn_id = result.pointer("/turn/id").and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Codex app-server did not return a turn id".to_string())?.to_string();
            // `turn/completed` can race the RPC response. Only update an
            // active run that still belongs to this invocation; never revive a
            // run that the notification path has already finalized.
            let _dispatch = self.inner.notification_dispatch.lock().await;
            let (should_interrupt, pending_notifications) = {
                let mut active_turns = self.inner.active_turns.lock().await;
                let active = active_turns
                    .get_mut(&flowix_thread_id)
                    .filter(|active| active.run_id == run_id);
                if let Some(active) = active {
                    active.codex_turn_id = codex_turn_id;
                    active.turn_ready.notify_one();
                    let pending = std::mem::take(&mut active.pending_notifications);
                    let should_interrupt =
                        active.cancel_requested && !active.codex_turn_id.is_empty();
                    if should_interrupt {
                        active.cancel_requested = false;
                    }
                    (should_interrupt, pending)
                } else {
                    (false, Vec::new())
                }
            };
            for notification in pending_notifications {
                dispatch_notification_inner(&self.inner, &notification).await;
            }
            drop(_dispatch);
            if should_interrupt {
                let active = self
                    .inner
                    .active_turns
                    .lock()
                    .await
                    .get(&flowix_thread_id)
                    .filter(|active| active.run_id == run_id)
                    .map(|active| (active.codex_thread_id.clone(), active.codex_turn_id.clone()));
                if let Some((codex_thread_id, codex_turn_id)) = active {
                    let _ = self
                        .request(
                            "turn/interrupt",
                            json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
                        )
                        .await;
                }
            }
            Ok::<(), String>(())
        }.await;
        if let Err(error) = started {
            let active = {
                let mut turns = self.inner.active_turns.lock().await;
                if turns
                    .get(&flowix_thread_id)
                    .is_some_and(|active| active.run_id == run_id)
                {
                    turns.remove(&flowix_thread_id)
                } else {
                    None
                }
            };
            // If the notification path already completed the turn, its
            // terminal event owns the run. Otherwise surface the RPC failure
            // and close the pre-registered lifecycle exactly once.
            if !stream_end_emitted.load(Ordering::Acquire) {
                self.emit_run_error(app_handle, &flowix_thread_id, error.clone(), &run_id)
                    .await;
                self.emit_stream_end(
                    app_handle,
                    &flowix_thread_id,
                    &run_id,
                    Some(error),
                    active
                        .as_ref()
                        .map(|turn| &turn.stream_end_emitted)
                        .unwrap_or(&stream_end_emitted),
                )
                .await;
            }
        }
        Ok(String::new())
    }

    pub async fn steer_chat(
        &self,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        let (turn_ready, is_chat_starting) = self
            .inner
            .active_turns
            .lock()
            .await
            .get(flowix_thread_id)
            .map(|turn| {
                (
                    turn.turn_ready.clone(),
                    turn.binding == TurnBinding::StartResponse
                        && turn.codex_turn_id.is_empty()
                        && turn.command_id.is_none(),
                )
            })
            .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
        if is_chat_starting {
            tokio::time::timeout(REQUEST_TIMEOUT, turn_ready.notified())
                .await
                .map_err(|_| "Codex turn did not become steerable in time".to_string())?;
        }
        let active = self
            .inner
            .active_turns
            .lock()
            .await
            .get(flowix_thread_id)
            .filter(|turn| turn.command_id.is_none() && !turn.codex_turn_id.is_empty())
            .map(|turn| (turn.codex_thread_id.clone(), turn.codex_turn_id.clone()))
            .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
        let input = codex_user_input(&message);
        // Register before the RPC: item/completed can beat its response. An
        // acknowledgement removes the receipt and the response never recreates it.
        {
            let mut turns = self.inner.active_turns.lock().await;
            let turn = turns
                .get_mut(flowix_thread_id)
                .filter(|turn| {
                    turn.codex_turn_id == active.1
                        && !turn.stream_end_emitted.load(Ordering::Acquire)
                })
                .ok_or_else(|| "Codex has no steerable active turn".to_string())?;
            if turn
                .pending_steers
                .iter()
                .any(|item| item["clientUserMessageId"] == client_user_message_id)
            {
                return Err("Codex steering already submitted".to_string());
            }
            turn.pending_steers.push(json!({
                "id": client_user_message_id, "clientUserMessageId": client_user_message_id,
                "input": input, "content": message.content, "runId": turn.run_id,
                "queuedAt": chrono::Utc::now().timestamp_millis(),
                "deliveryStatus": "submitting"
            }));
        }
        let result = self
            .request(
                "turn/steer",
                json!({
                    "threadId": active.0,
                    "expectedTurnId": active.1,
                    "clientUserMessageId": client_user_message_id,
                    "input": input,
                }),
            )
            .await;
        {
            let mut turns = self.inner.active_turns.lock().await;
            if let Some(turn) = turns
                .get_mut(flowix_thread_id)
                .filter(|turn| turn.codex_turn_id == active.1)
            {
                finish_pending_steer(
                    &mut turn.pending_steers,
                    &client_user_message_id,
                    result.is_ok(),
                );
            }
        }
        result?;
        let _ = app_handle;
        Ok(())
    }

    async fn resolve_queue_thread_id(&self, flowix_thread_id: &str) -> Result<String, String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread is not available for queue operations".to_string())?;
        self.request("thread/resume", json!({ "threadId": codex_thread_id }))
            .await?;
        Ok(codex_thread_id)
    }

    /// Add a Follow-up to Codex's persistent app-server queue.
    pub async fn queue_follow_up(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        let run_id = message
            .run_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(flowix_thread_id, None));
        let mut message = message;
        message.run_id = Some(run_id.clone());
        upsert_queued_follow_up(
            &self.inner,
            QueuedCodexFollowUp {
                flowix_thread_id: flowix_thread_id.to_string(),
                codex_thread_id: codex_thread_id.clone(),
                queued_submission_id: None,
                client_user_message_id: client_user_message_id.clone(),
                message: message.clone(),
                run_id,
            },
        )
        .await;
        let input = codex_user_input(&message);
        let result = self
            .request(
                "thread/queue/add",
                json!({
                    "threadId": codex_thread_id.clone(),
                    "clientUserMessageId": client_user_message_id.clone(),
                    "input": input,
                }),
            )
            .await;
        match result {
            Ok(result) => {
                let queued_submission_id = result
                    .pointer("/queuedSubmission/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(id) = queued_submission_id.as_deref() {
                    {
                        let mut by_thread = self.inner.queued_follow_ups.lock().await;
                        if let Some(queued) =
                            by_thread.get_mut(&codex_thread_id).and_then(|items| {
                                items.iter_mut().find(|item| {
                                    item.client_user_message_id == client_user_message_id
                                })
                            })
                        {
                            queued.queued_submission_id = Some(id.to_string());
                        }
                    }

                    let provider_is_idle = {
                        let mut active_turns = self.inner.active_turns.lock().await;
                        if active_turns.get(flowix_thread_id).is_some_and(|active| {
                            active.codex_thread_id == codex_thread_id
                                && active.stream_end_emitted.load(Ordering::Acquire)
                        }) {
                            active_turns.remove(flowix_thread_id);
                        }
                        !active_turns
                            .values()
                            .any(|active| active.codex_thread_id == codex_thread_id)
                    };
                    if provider_is_idle {
                        // The thread can become idle while this queue/add RPC
                        // is in flight. Start the provider's current queue
                        // head, which may be an older submission, instead of
                        // jumping directly to the item just added.
                        let queue_head = match self
                            .request(
                                "thread/queue/list",
                                json!({ "threadId": codex_thread_id.clone() }),
                            )
                            .await
                        {
                            Ok(queue) => {
                                remember_queued_follow_ups(
                                    &self.inner,
                                    flowix_thread_id,
                                    &codex_thread_id,
                                    &queue,
                                )
                                .await;
                                queued_follow_up_at_queue_head(
                                    flowix_thread_id,
                                    &codex_thread_id,
                                    &queue,
                                )
                            }
                            Err(error) => {
                                tracing::debug!(
                                    "Codex queue item accepted; could not inspect idle queue head: {error}"
                                );
                                None
                            }
                        };
                        if let Some(queue_head) = queue_head {
                            let head_id = queue_head.queued_submission_id.clone();
                            upsert_queued_follow_up(&self.inner, queue_head.clone()).await;
                            // Keep the message/run identity already
                            // associated with the Flowix optimistic row.
                            let head_message = if let Some(head_id) = head_id.as_deref() {
                                self.inner
                                    .queued_follow_ups
                                    .lock()
                                    .await
                                    .get(&codex_thread_id)
                                    .and_then(|items| {
                                        items.iter().find(|item| {
                                            item.queued_submission_id.as_deref() == Some(head_id)
                                        })
                                    })
                                    .map(|item| item.message.clone())
                            } else {
                                None
                            };
                            if let (Some(head_id), Some(head_message)) = (head_id, head_message) {
                                if let Err(error) = self
                                    .start_queued_follow_up(
                                        flowix_thread_id,
                                        &head_id,
                                        head_message,
                                        app_handle,
                                    )
                                    .await
                                {
                                    tracing::debug!(
                                        "Codex queue item accepted; deferred idle start: {error}"
                                    );
                                }
                            }
                        }
                    }
                }
                Ok(result)
            }
            Err(error) => {
                remove_queued_follow_up(
                    &self.inner,
                    &codex_thread_id,
                    None,
                    Some(&client_user_message_id),
                )
                .await;
                Err(error)
            }
        }
    }

    async fn list_queued_follow_ups_unlocked(
        &self,
        flowix_thread_id: &str,
        codex_thread_id: &str,
    ) -> Result<Value, String> {
        let result = self
            .request("thread/queue/list", json!({ "threadId": codex_thread_id }))
            .await?;
        remember_queued_follow_ups(&self.inner, flowix_thread_id, codex_thread_id, &result).await;
        Ok(result)
    }

    /// Read Codex's persistent queue so UI state can be restored after reload.
    pub async fn list_queued_follow_ups(&self, flowix_thread_id: &str) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        let result = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, &codex_thread_id)
            .await?;
        Ok(self.with_pending_steers(flowix_thread_id, result).await)
    }

    async fn with_pending_steers(&self, flowix_thread_id: &str, mut result: Value) -> Value {
        let turns = self.inner.active_turns.lock().await;
        result["pendingDeliveries"] = json!(turns
            .get(flowix_thread_id)
            .filter(|turn| !turn.stream_end_emitted.load(Ordering::Acquire))
            .map(|turn| turn.pending_steers.clone())
            .unwrap_or_default());
        result
    }

    /// Restore an idle provider queue into the normal run lifecycle. This is
    /// separate from `list_queued_follow_ups`, which is also used for
    /// read-before-delete and stale-item reconciliation.
    pub async fn restore_queued_follow_ups(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        let result = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, &codex_thread_id)
            .await?;
        // Restored provider queues may have no active turn to trigger Codex's
        // automatic queue drain. Reconcile and start the provider queue head
        // here so the webview only hydrates state; it does not choose work.
        let provider_is_idle = {
            let mut active_turns = self.inner.active_turns.lock().await;
            if active_turns.get(flowix_thread_id).is_some_and(|active| {
                active.codex_thread_id == codex_thread_id
                    && active.stream_end_emitted.load(Ordering::Acquire)
            }) {
                active_turns.remove(flowix_thread_id);
            }
            !active_turns
                .values()
                .any(|active| active.codex_thread_id == codex_thread_id)
        };
        if provider_is_idle {
            if let Some(head) =
                queued_follow_up_at_queue_head(flowix_thread_id, &codex_thread_id, &result)
            {
                if let Some(queue_id) = head.queued_submission_id.as_deref() {
                    upsert_queued_follow_up(&self.inner, head.clone()).await;
                    if let Err(error) = self
                        .start_queued_follow_up(
                            flowix_thread_id,
                            queue_id,
                            head.message,
                            app_handle,
                        )
                        .await
                    {
                        tracing::debug!("Codex restored queue start deferred: {error}");
                    }
                }
            }
        }
        Ok(self.with_pending_steers(flowix_thread_id, result).await)
    }

    pub async fn delete_queued_follow_up(
        &self,
        flowix_thread_id: &str,
        queued_submission_id: &str,
    ) -> Result<Value, String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        self.delete_queue_entry_with_retry(
            flowix_thread_id,
            &codex_thread_id,
            queued_submission_id,
        )
        .await?;
        Ok(json!({ "deleted": true }))
    }

    async fn delete_queue_entry(
        &self,
        codex_thread_id: &str,
        queued_submission_id: &str,
    ) -> Result<Value, String> {
        let result = self
            .request(
                "thread/queue/delete",
                json!({
                    "threadId": codex_thread_id,
                    "queuedSubmissionId": queued_submission_id,
                }),
            )
            .await?;
        if result.get("deleted").and_then(Value::as_bool) == Some(true) {
            remove_queued_follow_up(
                &self.inner,
                &codex_thread_id,
                Some(queued_submission_id),
                None,
            )
            .await;
        }
        Ok(result)
    }

    async fn delete_queue_entry_with_retry(
        &self,
        flowix_thread_id: &str,
        codex_thread_id: &str,
        queued_submission_id: &str,
    ) -> Result<(), String> {
        let first_error = match self
            .delete_queue_entry(codex_thread_id, queued_submission_id)
            .await
        {
            Ok(result) if result.get("deleted").and_then(Value::as_bool) == Some(true) => {
                return Ok(());
            }
            Ok(_) => "Codex queue delete did not confirm deletion".to_string(),
            Err(error) => error,
        };

        // A timed-out delete can still have succeeded remotely. Re-read before
        // retrying so a duplicate delivery cannot be queued by stale state.
        let queue = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, codex_thread_id)
            .await?;
        let still_queued = queue
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("id").and_then(Value::as_str) == Some(queued_submission_id)
                })
            });
        if !still_queued {
            return Ok(());
        }

        match self
            .delete_queue_entry(codex_thread_id, queued_submission_id)
            .await
        {
            Ok(result) if result.get("deleted").and_then(Value::as_bool) == Some(true) => Ok(()),
            Ok(_) => Err(first_error),
            Err(_) => Err(first_error),
        }
    }

    /// Explicitly start one queued message while the thread is idle, such as
    /// when restoring a persisted queue into a new Flowix session.
    async fn start_queued_follow_up(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        queued_submission_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        self.ensure_connection().await?;
        let flowix_thread_id = flowix_thread_id.to_string();
        let codex_thread_id = self.resolve_queue_thread_id(&flowix_thread_id).await?;
        let run_id = message
            .run_id
            .clone()
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(&flowix_thread_id, None));
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));

        // `thread/queue/start` starts a real provider turn. Register it before
        // the RPC so app-server notifications can be associated with this
        // product thread and delivered through the normal run lifecycle.
        {
            let mut active_turns = self.inner.active_turns.lock().await;
            if active_turns.contains_key(&flowix_thread_id) {
                return Err("Codex already has an active turn for this thread".to_string());
            }
            active_turns.insert(
                flowix_thread_id.clone(),
                ActiveTurn {
                    flowix_thread_id: flowix_thread_id.clone(),
                    run_id: run_id.clone(),
                    client_user_message_id: None,
                    codex_thread_id: codex_thread_id.clone(),
                    codex_turn_id: String::new(),
                    binding: TurnBinding::StartResponse,
                    pending_notifications: Vec::new(),
                    dropped_notifications: 0,
                    turn_ready: Arc::new(tokio::sync::Notify::new()),
                    cancel_requested: false,
                    stopping: false,
                    command_id: None,
                    command: None,
                    app_handle: app_handle.clone(),
                    started_at: chrono::Utc::now().timestamp_millis(),
                    last_event_at: chrono::Utc::now().timestamp_millis(),
                    stream_end_emitted: stream_end_emitted.clone(),
                    completed_agent_messages: completed_agent_messages.clone(),
                    pending_steers: Vec::new(),
                },
            );
        }
        self.emit_stream_start(app_handle, &flowix_thread_id, &message, &run_id)
            .await;

        let started = async {
            let result = self
                .request(
                    "thread/queue/start",
                    json!({
                        "threadId": codex_thread_id,
                        "queuedSubmissionId": queued_submission_id,
                    }),
                )
                .await?;
            let codex_turn_id = result
                .pointer("/turn/id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Codex app-server did not return a turn id".to_string())?
                .to_string();

            let _dispatch = self.inner.notification_dispatch.lock().await;
            let (should_interrupt, pending_notifications) = {
                let mut active_turns = self.inner.active_turns.lock().await;
                let Some(active) = active_turns
                    .get_mut(&flowix_thread_id)
                    .filter(|active| active.run_id == run_id)
                else {
                    return Ok(result);
                };
                active.codex_turn_id = codex_turn_id;
                active.turn_ready.notify_one();
                let pending = std::mem::take(&mut active.pending_notifications);
                let should_interrupt = active.cancel_requested && !active.codex_turn_id.is_empty();
                if should_interrupt {
                    active.cancel_requested = false;
                }
                (should_interrupt, pending)
            };
            for notification in pending_notifications {
                dispatch_notification_inner(&self.inner, &notification).await;
            }
            drop(_dispatch);
            if should_interrupt {
                let active = self
                    .inner
                    .active_turns
                    .lock()
                    .await
                    .get(&flowix_thread_id)
                    .filter(|active| active.run_id == run_id)
                    .map(|active| (active.codex_thread_id.clone(), active.codex_turn_id.clone()));
                if let Some((codex_thread_id, codex_turn_id)) = active {
                    let _ = self
                        .request(
                            "turn/interrupt",
                            json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
                        )
                        .await;
                }
            }
            Ok::<Value, String>(result)
        }
        .await;

        match started {
            Ok(result) => {
                remove_queued_follow_up(
                    &self.inner,
                    &codex_thread_id,
                    Some(queued_submission_id),
                    None,
                )
                .await;
                Ok(result)
            }
            Err(error) => {
                // The queue can auto-start as the current turn ends, between
                // our list and explicit start calls. In that case its
                // notifications were buffered against this optimistic run.
                // Bind the actual started turn and replay them instead of
                // discarding the real response as a stale queue error.
                let _dispatch = self.inner.notification_dispatch.lock().await;
                let (started_turn, pending_notifications, active_for_end) = {
                    let mut active_turns = self.inner.active_turns.lock().await;
                    let active = active_turns
                        .get_mut(&flowix_thread_id)
                        .filter(|active| active.run_id == run_id);
                    if let Some(active) = active {
                        let started_turn_id = active
                            .pending_notifications
                            .iter()
                            .find(|notification| {
                                notification.get("method").and_then(Value::as_str)
                                    == Some("turn/started")
                                    && notification
                                        .pointer("/params/threadId")
                                        .and_then(Value::as_str)
                                        == Some(active.codex_thread_id.as_str())
                            })
                            .and_then(|notification| {
                                notification
                                    .pointer("/params/turnId")
                                    .or_else(|| notification.pointer("/params/turn/id"))
                                    .and_then(Value::as_str)
                            })
                            .map(str::to_string);
                        if let Some(turn_id) = started_turn_id {
                            active.codex_turn_id = turn_id.clone();
                            active.binding = TurnBinding::StartedNotification;
                            active.turn_ready.notify_one();
                            let pending = std::mem::take(&mut active.pending_notifications);
                            (
                                Some(turn_id),
                                pending,
                                Some(active.stream_end_emitted.clone()),
                            )
                        } else {
                            let active = active_turns.remove(&flowix_thread_id);
                            (None, Vec::new(), active.map(|turn| turn.stream_end_emitted))
                        }
                    } else {
                        (None, Vec::new(), None)
                    }
                };
                if let Some(turn_id) = started_turn {
                    for notification in pending_notifications {
                        dispatch_notification_inner(&self.inner, &notification).await;
                    }
                    drop(_dispatch);
                    remove_queued_follow_up(
                        &self.inner,
                        &codex_thread_id,
                        Some(queued_submission_id),
                        None,
                    )
                    .await;
                    return Ok(json!({
                        "turn": { "id": turn_id, "status": "inProgress" }
                    }));
                }
                drop(_dispatch);
                let active = {
                    let mut active_turns = self.inner.active_turns.lock().await;
                    if active_turns
                        .get(&flowix_thread_id)
                        .is_some_and(|active| active.run_id == run_id)
                    {
                        active_turns.remove(&flowix_thread_id)
                    } else {
                        None
                    }
                };
                if !stream_end_emitted.load(Ordering::Acquire) {
                    // Another window or a concurrent provider-side transition
                    // may have consumed this durable queue item. Close the
                    // optimistic run cleanly so the frontend can refresh the
                    // queue without showing a false model failure.
                    if !is_queue_start_conflict_error(&error) {
                        self.emit_run_error(app_handle, &flowix_thread_id, error.clone(), &run_id)
                            .await;
                    }
                    self.emit_stream_end(
                        app_handle,
                        &flowix_thread_id,
                        &run_id,
                        (!is_queue_start_conflict_error(&error)).then(|| error.clone()),
                        active
                            .as_ref()
                            .map(|turn| &turn.stream_end_emitted)
                            .or(active_for_end.as_ref())
                            .unwrap_or(&stream_end_emitted),
                    )
                    .await;
                }
                Err(error)
            }
        }
    }

    /// Deliver a selected Follow-up immediately. Runtime state is authoritative:
    /// steer an active chat, or start the queued submission when idle.
    pub async fn deliver_queued_follow_up_now(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        queued_submission_id: &str,
        message: AgentUserMessage,
        client_user_message_id: String,
        app_handle: &tauri::AppHandle,
    ) -> Result<(), String> {
        let codex_thread_id = self.resolve_queue_thread_id(flowix_thread_id).await?;
        let _queue_operation = lock_follow_up_operations(&self.inner, flowix_thread_id).await;
        let queue = self
            .list_queued_follow_ups_unlocked(flowix_thread_id, &codex_thread_id)
            .await?;
        let target_is_queued = queue
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items.iter().any(|item| {
                    item.get("id").and_then(Value::as_str) == Some(queued_submission_id)
                })
            });
        if !target_is_queued {
            return Err(format!(
                "queued submission not found: {queued_submission_id}"
            ));
        }
        let active_turn = {
            let active_turns = self.inner.active_turns.lock().await;
            let active = active_turns.get(flowix_thread_id);
            if active.is_some_and(|active| {
                active.client_user_message_id.as_deref() == Some(client_user_message_id.as_str())
                    && !active.stream_end_emitted.load(Ordering::Acquire)
            }) {
                return Err("Codex Follow-up already started".to_string());
            }
            active.is_some_and(|active| {
                active.command_id.is_none() && !active.stream_end_emitted.load(Ordering::Acquire)
            })
        };
        if !active_turn {
            self.start_queued_follow_up(
                flowix_thread_id,
                queued_submission_id,
                message,
                app_handle,
            )
            .await?;
            return Ok(());
        }

        self.steer_chat(
            flowix_thread_id,
            message,
            client_user_message_id,
            app_handle,
        )
        .await?;
        match self
            .delete_queue_entry_with_retry(flowix_thread_id, &codex_thread_id, queued_submission_id)
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => Err(format!(
                "Codex Follow-up was steered but queue cleanup failed: {error}"
            )),
        }
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let active = {
            let mut active_turns = self.inner.active_turns.lock().await;
            if let Some(expected) = run_id.filter(|id| !id.trim().is_empty()) {
                if active_turns
                    .get(thread_id)
                    .is_some_and(|active| active.run_id != expected)
                {
                    return false;
                }
            }
            match active_turns.get_mut(thread_id) {
                Some(active) if active.stopping => return false,
                Some(active) if active.codex_turn_id.is_empty() => {
                    // The command/turn RPC may still be in flight. Do not
                    // remove the entry yet: a later turn/started notification
                    // is the only reliable place to learn the turn id that
                    // must receive turn/interrupt.
                    active.cancel_requested = true;
                    active.stopping = true;
                    active.clone()
                }
                Some(active) => {
                    active.stopping = true;
                    active.clone()
                }
                None => {
                    // Ordinary chat and slash commands can both be stopped
                    // before registering a native turn. Hold active_turns until
                    // the scoped cancellation is visible to the startup path.
                    if let Some(run_id) = run_id.filter(|id| !id.trim().is_empty()) {
                        self.inner
                            .pending_cancellations
                            .lock()
                            .await
                            .insert(thread_id.to_string(), run_id.to_string());
                        return true;
                    }
                    return false;
                }
            }
        };
        if !active.codex_turn_id.is_empty() {
            if let Err(error) = self
                .request(
                    "turn/interrupt",
                    json!({ "threadId": active.codex_thread_id, "turnId": active.codex_turn_id }),
                )
                .await
            {
                tracing::warn!("[Codex] StopUnconfirmed for run {}: {error}", active.run_id);
                return false;
            }
        }
        let confirmed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let still_active = self
                    .inner
                    .active_turns
                    .lock()
                    .await
                    .get(thread_id)
                    .is_some_and(|current| current.run_id == active.run_id);
                if !still_active {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();
        if !confirmed {
            tracing::warn!("[Codex] StopUnconfirmed for run {}", active.run_id);
        }
        let _ = app_handle;
        confirmed
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.inner
            .active_turns
            .lock()
            .await
            .iter()
            .map(|(id, active)| {
                let mut info = RunInfo::active(
                    active.started_at,
                    None,
                    Some(AGENT_TYPE),
                    Some(active.run_id.clone()),
                    Some(active.flowix_thread_id.clone()),
                    Some(active.codex_thread_id.clone()),
                );
                if active.stopping {
                    info.phase = Some("stopping".to_string());
                }
                (id.clone(), info)
            })
            .collect()
    }

    /// Return Codex's background terminal processes for a product thread.
    /// The app-server response is intentionally kept as JSON: the protocol is
    /// experimental and its terminal fields have changed between Codex builds.
    pub async fn list_background_terminals(&self, flowix_thread_id: &str) -> Result<Value, String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let Some(codex_thread_id) = select_external_session_for_runtime(stored, None) else {
            return Ok(json!({ "data": [] }));
        };
        self.request(
            "thread/backgroundTerminals/list",
            json!({ "threadId": codex_thread_id }),
        )
        .await
    }

    pub async fn stop_all(&self) -> usize {
        let active = {
            let mut turns = self.inner.active_turns.lock().await;
            for turn in turns.values_mut() {
                turn.stopping = true;
                turn.cancel_requested = true;
            }
            turns.values().cloned().collect::<Vec<_>>()
        };
        let count = active.len();
        for turn in active {
            if !turn.codex_turn_id.is_empty() {
                let _ = self
                    .request(
                        "turn/interrupt",
                        json!({ "threadId": turn.codex_thread_id, "turnId": turn.codex_turn_id }),
                    )
                    .await;
            }
        }

        // The app-server is shared by all Codex threads and is not owned by
        // any single turn. Explicitly terminate it during application
        // shutdown; dropping `tokio::process::Child` alone does not guarantee
        // that the child process exits.
        let generation = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.generation);
        if let Some(generation) = generation {
            close_connection(&self.inner, generation).await;
        }
        count
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let now = chrono::Utc::now().timestamp_millis();
        let stale = self
            .inner
            .active_turns
            .lock()
            .await
            .iter()
            .filter_map(|(id, active)| {
                ((now - active.last_event_at) > idle_timeout_ms).then_some(id.clone())
            })
            .collect::<Vec<_>>();
        let mut count = 0;
        for id in stale {
            if self.stop_chat(&id, None, app_handle).await {
                count += 1;
            }
        }
        count
    }

    pub async fn supported_model_catalog(&self) -> Result<Vec<Value>, String> {
        self.ensure_connection().await?;
        let result = self.request("model/list", json!({ "limit": 100 })).await?;
        let mut seen = std::collections::HashSet::new();
        Ok(result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model
                    .get("model")
                    .or_else(|| model.get("id"))
                    .or_else(|| model.get("slug"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty() && !id.eq_ignore_ascii_case("inherit"))?;
                let source_efforts = model
                    .get("supportedReasoningEfforts")
                    .or_else(|| model.get("supported_reasoning_efforts"))
                    .or_else(|| model.get("supported_reasoning_levels"));
                let reasoning_efforts = source_efforts
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|effort| {
                        effort
                            .as_str()
                            .or_else(|| {
                                effort
                                    .get("reasoningEffort")
                                    .or_else(|| effort.get("effort"))
                                    .or_else(|| effort.get("reasoning_effort"))
                                    .and_then(Value::as_str)
                            })
                    })
                    .map(str::to_ascii_lowercase)
                    .filter(|effort| {
                        matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max" | "ultra")
                    })
                    .collect::<Vec<_>>();
                Some((id.to_string(), reasoning_efforts))
            })
            .filter(|(id, _)| seen.insert(id.clone()))
            .map(|(id, reasoning_efforts)| json!({ "id": id, "reasoningEfforts": reasoning_efforts }))
            .collect())
    }

    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        Ok(self
            .supported_model_catalog()
            .await?
            .into_iter()
            .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
            .collect())
    }

    /// Read the account snapshot used by the Codex badge popover. Rate limits
    /// are deliberately returned as raw JSON because the app-server schema is
    /// experimental and has added buckets over time.
    pub async fn runtime_info(&self, thread_id: Option<&str>) -> Result<Value, String> {
        self.ensure_connection().await?;
        let account = self
            .request("account/read", json!({ "refreshToken": false }))
            .await
            .unwrap_or(Value::Null);
        let rate_limits = self
            .request("account/rateLimits/read", json!({}))
            .await
            .unwrap_or(Value::Null);
        let usage = match thread_id {
            Some(id) => self.inner.latest_usage.lock().await.get(id).cloned(),
            None => None,
        };
        Ok(json!({
            "account": account.get("account").cloned().unwrap_or(Value::Null),
            "rateLimits": rate_limits,
            "usage": usage,
        }))
    }

    pub async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.ensure_connection().await?;
        let mut cursor = None;
        let mut threads = Vec::new();
        loop {
            let result = self
                .request(
                    "thread/list",
                    json!({
                        "cursor": cursor,
                        "limit": 100,
                        "sortKey": "recency_at",
                        "sourceKinds": ["cli", "vscode", "appServer"]
                    }),
                )
                .await?;
            threads.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(app_server_thread_info),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }

        // The App Server owns provider session ids, while Flowix owns the
        // product thread ids used by conversation instances and titles.  The
        // UI must receive the product id for every known binding; otherwise
        // a title lookup compares `threads.title` against a provider id and
        // falls back to a runtime-wide title slot.
        let bindings = self
            .inner
            .thread_manager
            .list_external_session_bindings(AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        for thread in &mut threads {
            let Some(product_thread_id) = bindings.get(&thread.thread_id) else {
                continue;
            };
            if let Some(product_info) = self
                .inner
                .thread_manager
                .get_thread_info(product_thread_id)
                .await
                .map_err(|error| error.to_string())?
            {
                *thread = product_info;
            } else {
                thread.thread_id = product_thread_id.clone();
            }
        }
        Ok(threads)
    }

    pub async fn get_thread_messages(&self, thread_id: &str) -> Result<Vec<ChatMessage>, String> {
        let mut page = self
            .get_thread_messages_page(thread_id, None, None, 1000)
            .await?;
        let snapshot_sequence = page.snapshot_sequence;
        let mut messages = page.messages;
        while page.has_more {
            page = self
                .get_thread_messages_page(thread_id, page.oldest_sequence, snapshot_sequence, 1000)
                .await?;
            let mut older = page.messages;
            older.append(&mut messages);
            messages = older;
        }
        Ok(messages)
    }

    pub async fn get_thread_messages_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        snapshot_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, String> {
        self.ensure_connection().await?;
        // `thread/turns/list(itemsView: "full")` is the authoritative
        // persisted transcript shape: it preserves the server's turn and item
        // ordering, includes command/tool items, and keeps terminal status on
        // its owning turn. Do not flatten `thread/items/list` and reconstruct
        // that relationship from timestamps: every item in a turn commonly
        // shares `startedAt`, which makes a later history/live merge able to
        // reorder tool rows.
        let mut cursor: Option<String> = None;
        let mut turns = Vec::new();
        loop {
            let result = self
                .request(
                    "thread/turns/list",
                    json!({
                        "threadId": thread_id,
                        "cursor": cursor,
                        "limit": 100,
                        "sortDirection": "asc",
                        "itemsView": "full"
                    }),
                )
                .await
                .map_err(|error| {
                    format!(
                        "Codex paginated history requires Codex CLI {MIN_PAGINATED_CODEX_VERSION} or newer. Update with `npm install -g @openai/codex@latest --force --include=optional`. App Server error: {error}"
                    )
                })?;
            turns.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        // Codex deliberately omits a native goal command (and its hidden
        // context) from `thread/turns/list`. Read the current provider-owned
        // goal state only to restore the latest goal row; no Flowix message
        // history is written or consulted here.
        if let Ok(goal) = self
            .request("thread/goal/get", json!({ "threadId": thread_id }))
            .await
        {
            annotate_goal_turn(&mut turns, &goal);
        }
        Ok(paginate_app_server_turns(
            &turns,
            before_sequence,
            snapshot_sequence,
            limit,
        ))
    }

    /// Fork a persisted Codex thread at the requested completed Turn and bind
    /// the new Codex session to a new Flowix product thread.
    pub async fn fork_thread(
        &self,
        flowix_thread_id: &str,
        last_turn_id: &str,
        new_flowix_thread_id: &str,
    ) -> Result<String, String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let source_codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread has not been started".to_string())?;
        let result = self
            .request(
                "thread/fork",
                json!({
                    "threadId": source_codex_thread_id,
                    "lastTurnId": last_turn_id,
                    "historyMode": "paginated"
                }),
            )
            .await?;
        let new_codex_thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Codex app-server did not return a forked thread id".to_string())?
            .to_string();
        self.inner
            .thread_manager
            .upsert_external_session(
                new_flowix_thread_id,
                AGENT_TYPE,
                &new_codex_thread_id,
                Some(result),
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(new_codex_thread_id)
    }

    /// Archive the provider-side Codex thread: the rollout moves into Codex's
    /// archived sessions directory, so `thread/list` stops returning it. The
    /// rollout stays recoverable through `thread/unarchive`.
    pub async fn archive_thread(&self, codex_thread_id: &str) -> Result<(), String> {
        self.provider_thread_lifecycle("thread/archive", codex_thread_id)
            .await
    }

    /// Hard-delete the provider-side Codex thread together with any spawned
    /// descendant threads. Rollout files and metadata are removed permanently;
    /// missing rollouts are treated as already deleted by the app-server.
    pub async fn delete_thread(&self, codex_thread_id: &str) -> Result<(), String> {
        self.provider_thread_lifecycle("thread/delete", codex_thread_id)
            .await
    }

    async fn provider_thread_lifecycle(
        &self,
        method: &str,
        codex_thread_id: &str,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        self.request(method, json!({ "threadId": codex_thread_id }))
            .await?;
        Ok(())
    }

    /// Reply to a server-initiated JSON-RPC request with its original id.
    /// RequestId is kept as JSON text for compatibility with numeric and
    /// string ids emitted by different app-server versions.
    pub async fn respond_to_server_request(
        &self,
        request_id: &str,
        result: Value,
    ) -> Result<(), String> {
        let mut pending = self.inner.pending_approvals.lock().await;
        let Some(index) = pending
            .iter()
            .position(|request| request.request_id == request_id)
        else {
            return Err("Codex approval request is no longer pending".to_string());
        };
        pending.remove(index);
        drop(pending);
        let id = serde_json::from_str::<Value>(request_id)
            .map_err(|_| "Invalid Codex approval request id".to_string())?;
        self.write(json!({ "id": id, "result": result })).await
    }

    pub async fn pending_approval_requests(&self) -> Vec<CodexApprovalRequest> {
        self.inner.pending_approvals.lock().await.clone()
    }

    /// Apply settings to an existing Codex thread. These settings affect the
    /// next turn and preserve the conversation history.
    pub async fn update_thread_settings(
        &self,
        flowix_thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        permission_mode: Option<&str>,
    ) -> Result<(), String> {
        self.ensure_connection().await?;
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let codex_thread_id = select_external_session_for_runtime(stored, None)
            .ok_or_else(|| "Codex thread has not been started".to_string())?;
        let mut settings = serde_json::Map::new();
        if let Some(model) = model.filter(|value| !value.trim().is_empty() && *value != "inherit") {
            settings.insert("model".into(), json!(model));
        }
        if let Some(effort) =
            reasoning_effort.filter(|value| !value.trim().is_empty() && *value != "inherit")
        {
            settings.insert("reasoningEffort".into(), json!(effort));
        }
        if let Some(permission) = permission_mode {
            settings.insert("sandboxPolicy".into(), app_server_sandbox(Some(permission)));
        }
        if settings.is_empty() {
            return Ok(());
        }
        settings.insert("threadId".into(), json!(codex_thread_id));
        self.request("thread/settings/update", Value::Object(settings).into())
            .await?;
        Ok(())
    }

    /// Execute a Codex-native composer command without sending the slash text
    /// through `turn/start`. The TUI handles these commands locally; Flowix
    /// must call the equivalent App Server method explicitly.
    pub async fn execute_slash_command(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        command: &str,
        runtime_config: Option<AgentRuntimeConfig>,
        provided_run_id: Option<&str>,
        provided_command_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> Result<Value, String> {
        // Capture the command's logical position before any connection,
        // session lookup, or RPC work can delay the terminal event.
        let started_at = chrono::Utc::now().timestamp_millis();
        self.ensure_connection().await?;
        *self.inner.app_handle.lock().await = Some(app_handle.clone());
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(flowix_thread_id)
        {
            return Err("Codex already has active work for this thread".to_string());
        }
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let command = command.trim();
        let run_id = provided_run_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(flowix_thread_id, None));
        let message = AgentUserMessage {
            content: command.to_string(),
            llm_content: None,
            image_paths: Vec::new(),
            run_id: Some(run_id.clone()),
            system_reminder_directory: None,
            agent_type: Some(AGENT_TYPE.to_string()),
            runtime_config,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        };
        let codex_thread_id = match select_external_session_for_runtime(stored, None) {
            Some(codex_thread_id) => codex_thread_id,
            None => {
                self.resolve_codex_thread(flowix_thread_id, &message)
                    .await?
                    .0
            }
        };

        let command_id = provided_command_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("codex-command-{}", uuid::Uuid::new_v4()));
        let waits_for_provider_turn =
            is_codex_compact_command(command) || is_codex_goal_mutation_command(command);
        let ended = Arc::new(AtomicBool::new(false));
        let completed_agent_messages = Arc::new(Mutex::new(Vec::new()));
        // Native commands can either be an immediate thread operation or
        // return/start a provider turn. `/goal` is a mutation RPC whose
        // response is followed by an autonomous provider turn, as shown by
        // Codex's `thread_goal_updated -> task_started` event sequence. Keep
        // an empty turn id temporarily: `turn/started` can arrive before the
        // command RPC response and fills it in. Register before emitting the
        // optimistic lifecycle events so an immediate stop cannot miss it.
        let cancelled_before_start = {
            let mut turns = self.inner.active_turns.lock().await;
            let cancelled = take_pending_cancellation(
                &mut *self.inner.pending_cancellations.lock().await,
                flowix_thread_id,
                &run_id,
            );
            if !cancelled {
                turns.insert(
                    flowix_thread_id.to_string(),
                    ActiveTurn {
                        flowix_thread_id: flowix_thread_id.to_string(),
                        run_id: run_id.clone(),
                        client_user_message_id: None,
                        codex_thread_id: codex_thread_id.clone(),
                        codex_turn_id: String::new(),
                        binding: TurnBinding::StartedNotification,
                        pending_notifications: Vec::new(),
                        dropped_notifications: 0,
                        turn_ready: Arc::new(tokio::sync::Notify::new()),
                        cancel_requested: false,
                        stopping: false,
                        command_id: Some(command_id.clone()),
                        command: Some(command.to_string()),
                        app_handle: app_handle.clone(),
                        started_at,
                        last_event_at: chrono::Utc::now().timestamp_millis(),
                        stream_end_emitted: ended.clone(),
                        completed_agent_messages: completed_agent_messages.clone(),
                        pending_steers: Vec::new(),
                    },
                );
            }
            cancelled
        };
        if cancelled_before_start {
            self.emit_codex_command(
                app_handle,
                flowix_thread_id,
                &run_id,
                &command_id,
                command,
                started_at,
                "cancelled",
                Some("Command interrupted".to_string()),
            )
            .await;
            self.emit_stream_end(
                app_handle,
                flowix_thread_id,
                &run_id,
                Some(USER_STOPPED_REASON.to_string()),
                &ended,
            )
            .await;
            return Ok(json!({ "cancelled": true }));
        }
        self.emit_codex_command(
            app_handle,
            flowix_thread_id,
            &run_id,
            &command_id,
            command,
            started_at,
            "pending",
            None,
        )
        .await;
        self.emit_stream_start(app_handle, flowix_thread_id, &message, &run_id)
            .await;

        let result = match self.execute_slash_request(&codex_thread_id, command).await {
            Ok(result) => result,
            Err(error) => {
                let mut turns = self.inner.active_turns.lock().await;
                if turns
                    .get(flowix_thread_id)
                    .is_some_and(|active| active.run_id == run_id)
                {
                    turns.remove(flowix_thread_id);
                }
                drop(turns);
                // A stop can win while the command RPC is still pending. In
                // that case stop_chat already emitted the cancelled command
                // and stream end; do not overwrite them with an RPC error.
                if !ended.load(Ordering::Acquire) {
                    self.emit_codex_command(
                        app_handle,
                        flowix_thread_id,
                        &run_id,
                        &command_id,
                        command,
                        started_at,
                        "error",
                        Some(error.clone()),
                    )
                    .await;
                    self.emit_run_error(app_handle, flowix_thread_id, error.clone(), &run_id)
                        .await;
                    self.emit_stream_end(
                        app_handle,
                        flowix_thread_id,
                        &run_id,
                        Some(error.clone()),
                        &ended,
                    )
                    .await;
                }
                return Err(error);
            }
        };

        let response_turn_id = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        let _dispatch = self.inner.notification_dispatch.lock().await;
        let (has_provider_turn, should_interrupt, pending_notifications) = {
            let mut active_turns = self.inner.active_turns.lock().await;
            let active = active_turns
                .get_mut(flowix_thread_id)
                .filter(|active| active.run_id == run_id);
            if let Some(active) = active {
                if active.codex_turn_id.is_empty() {
                    if let Some(turn_id) = response_turn_id {
                        active.codex_turn_id = turn_id;
                        active.turn_ready.notify_one();
                    }
                }
                let pending = if active.codex_turn_id.is_empty() {
                    Vec::new()
                } else {
                    std::mem::take(&mut active.pending_notifications)
                };
                let should_interrupt = active.cancel_requested && !active.codex_turn_id.is_empty();
                if should_interrupt {
                    // Only one path should schedule the interrupt. The
                    // notification path performs the same handoff for a
                    // turn/started event that beats this RPC response.
                    active.cancel_requested = false;
                }
                (!active.codex_turn_id.is_empty(), should_interrupt, pending)
            } else {
                (false, false, Vec::new())
            }
        };
        for notification in pending_notifications {
            dispatch_notification_inner(&self.inner, &notification).await;
        }
        drop(_dispatch);
        if should_interrupt {
            let active = self
                .inner
                .active_turns
                .lock()
                .await
                .get(flowix_thread_id)
                .filter(|active| active.run_id == run_id)
                .map(|active| (active.codex_thread_id.clone(), active.codex_turn_id.clone()));
            if let Some((codex_thread_id, codex_turn_id)) = active {
                let _ = self
                    .request(
                        "turn/interrupt",
                        json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
                    )
                    .await;
            }
        }
        // A command may finish its provider turn before the request response
        // is delivered. In that case the notification path already emitted
        // the terminal command/stream events and there is nothing left to do.
        if !has_provider_turn && ended.load(Ordering::Acquire) {
            return Ok(result);
        }
        // `thread/compact/start` and `thread/goal/set` return before the
        // asynchronous provider turn is announced. Keep their command row
        // pending even if `turn/started` has not arrived yet; otherwise the
        // next notification would be dropped as a late event. Read/clear
        // operations remain synchronous and are finalized from their RPC
        // response.
        if !has_provider_turn && !waits_for_provider_turn {
            let mut turns = self.inner.active_turns.lock().await;
            if turns
                .get(flowix_thread_id)
                .is_some_and(|active| active.run_id == run_id)
            {
                turns.remove(flowix_thread_id);
            }
            drop(turns);
            self.emit_codex_command(
                app_handle,
                flowix_thread_id,
                &run_id,
                &command_id,
                command,
                started_at,
                "success",
                codex_command_result_text(command, &result),
            )
            .await;
            self.emit_stream_end(app_handle, flowix_thread_id, &run_id, None, &ended)
                .await;
        }
        Ok(result)
    }

    async fn emit_codex_command(
        &self,
        app_handle: &tauri::AppHandle,
        thread_id: &str,
        run_id: &str,
        command_id: &str,
        command: &str,
        timestamp: i64,
        status: &str,
        result: Option<String>,
    ) {
        let chunk = AgentChunk::CodexCommand {
            thread_id: thread_id.to_string(),
            id: command_id.to_string(),
            command: command.to_string(),
            status: status.to_string(),
            result,
            timestamp,
        };
        emit_chunk_with_run_id(app_handle, &chunk, AGENT_TYPE, run_id);
    }

    async fn execute_slash_request(
        &self,
        codex_thread_id: &str,
        command: &str,
    ) -> Result<Value, String> {
        if is_codex_compact_command(command) {
            return self
                .request(
                    "thread/compact/start",
                    json!({ "threadId": codex_thread_id }),
                )
                .await;
        }
        let lower = command.to_ascii_lowercase();
        let rest = lower
            .strip_prefix("/goal")
            .filter(|rest| rest.chars().next().is_none_or(char::is_whitespace))
            .map(|_| command[5..].trim())
            .ok_or_else(|| format!("Unsupported Codex slash command: {command}"))?;
        if rest.is_empty() || rest.eq_ignore_ascii_case("get") {
            return self
                .request("thread/goal/get", json!({ "threadId": codex_thread_id }))
                .await;
        }
        if rest.eq_ignore_ascii_case("clear") {
            return self
                .request("thread/goal/clear", json!({ "threadId": codex_thread_id }))
                .await;
        }
        if rest.eq_ignore_ascii_case("pause") || rest.eq_ignore_ascii_case("resume") {
            let current = self
                .request("thread/goal/get", json!({ "threadId": codex_thread_id }))
                .await?;
            let goal = current.get("goal").cloned().unwrap_or(Value::Null);
            let objective = goal
                .get("objective")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "No Codex goal is currently set".to_string())?;
            let status = if rest.eq_ignore_ascii_case("pause") {
                "paused"
            } else {
                "active"
            };
            return self
                .request(
                    "thread/goal/set",
                    json!({
                        "threadId": codex_thread_id,
                        "objective": objective,
                        "status": status,
                        "tokenBudget": goal.get("tokenBudget").cloned().unwrap_or(Value::Null)
                    }),
                )
                .await;
        }
        let objective = rest
            .strip_prefix("edit ")
            .or_else(|| rest.strip_prefix("set "))
            .unwrap_or(rest)
            .trim();
        if objective.is_empty() || objective.len() > 4_000 {
            return Err("Codex goal objective must contain 1–4000 characters".to_string());
        }
        self.request(
            "thread/goal/set",
            json!({
                "threadId": codex_thread_id,
                "objective": objective,
                "status": "active"
            }),
        )
        .await
    }
}

async fn write_inner(inner: &Arc<Inner>, message: Value) -> Result<(), String> {
    let stdin = inner
        .connection
        .lock()
        .await
        .as_ref()
        .map(|connection| connection.stdin.clone())
        .ok_or_else(|| "Codex app-server is not connected".to_string())?;
    let mut stdin = stdin.lock().await;
    let encoded = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    stdin
        .write_all(encoded.as_bytes())
        .await
        .map_err(|error| format!("failed to write to Codex app-server: {error}"))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| format!("failed to delimit Codex app-server message: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush Codex app-server input: {error}"))
}

async fn request_inner(inner: &Arc<Inner>, method: &str, params: Value) -> Result<Value, String> {
    let id = inner.next_request_id.fetch_add(1, Ordering::Relaxed);
    let (sender, receiver) = oneshot::channel();
    inner.pending.lock().await.insert(id, sender);
    if let Err(error) = write_inner(
        inner,
        json!({ "id": id, "method": method, "params": params }),
    )
    .await
    {
        inner.pending.lock().await.remove(&id);
        return Err(error);
    }
    match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!(
            "Codex app-server closed before responding to {method}"
        )),
        Err(_) => {
            inner.pending.lock().await.remove(&id);
            Err(format!("Codex app-server timed out responding to {method}"))
        }
    }
}

fn codex_command_result_text(command: &str, result: &Value) -> Option<String> {
    if !command
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("/goal")
    {
        return None;
    }
    let goal = result.get("goal").unwrap_or(&Value::Null);
    if goal.is_null() {
        return Some("No Codex goal is currently set".to_string());
    }
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let status = goal
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("active");
    if objective.is_empty() {
        return Some(format!("Codex goal: {status}"));
    }
    Some(format!("{objective} ({status})"))
}

fn is_codex_compact_command(command: &str) -> bool {
    command.trim().eq_ignore_ascii_case("/compact")
}

/// Codex applies a goal mutation immediately, then starts/resumes the goal's
/// autonomous work. The `thread/goal/set` response therefore does not mark
/// the user-visible operation complete; its following provider turn does.
/// `/goal` (get) and `/goal clear` only read or clear state and do not start a
/// provider turn.
fn is_codex_goal_mutation_command(command: &str) -> bool {
    let trimmed = command.trim();
    let lower = trimmed.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("/goal")
        .filter(|rest| rest.chars().next().is_none_or(char::is_whitespace))
    else {
        return false;
    };
    let rest = rest.trim();
    !rest.is_empty() && !rest.eq_ignore_ascii_case("get") && !rest.eq_ignore_ascii_case("clear")
}

async fn verify_paginated_codex_version() -> Result<(), String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        build_codex_entrypoint().arg("--version").output(),
    )
    .await
    .map_err(|_| "Timed out reading Codex CLI version".to_string())?
    .map_err(|error| format!("Unable to read Codex CLI version: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    let version = text
        .split_whitespace()
        .find_map(|part| parse_codex_version(part.trim_start_matches('v')))
        .ok_or_else(|| format!("Unable to parse Codex CLI version from `{text}`"))?;
    let minimum = parse_codex_version(MIN_PAGINATED_CODEX_VERSION)
        .expect("minimum Codex version must be valid");
    if version < minimum {
        return Err(format!(
            "Flowix paginated history requires Codex CLI {MIN_PAGINATED_CODEX_VERSION} or newer (installed: {text}). Update with `npm install -g @openai/codex@latest --force --include=optional`."
        ));
    }
    Ok(())
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for CodexAppServerManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }
    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        emit_chunk_with_run_id(app, chunk, AGENT_TYPE, run_id);
    }
}

async fn read_loop(
    inner: Arc<Inner>,
    stdin: Arc<Mutex<ChildStdin>>,
    mut reader: BufReader<tokio::process::ChildStdout>,
    generation: u64,
) {
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line).await else {
            break;
        };
        if bytes == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = message.get("id") {
            if let Some(id_number) = id.as_u64() {
                if let Some(sender) = inner.pending.lock().await.remove(&id_number) {
                    let result = message
                        .get("error")
                        .map(|error| {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Codex app-server request failed")
                                .to_string())
                        })
                        .unwrap_or_else(|| {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        });
                    let _ = sender.send(result);
                    continue;
                }
            }
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                if is_user_decision_request(method) {
                    let request_id = id.to_string();
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let codex_thread_id = request_context(&params, "threadId");
                    let flowix_thread_id = if let Some(codex_thread_id) = codex_thread_id.as_deref()
                    {
                        inner
                            .active_turns
                            .lock()
                            .await
                            .values()
                            .find(|turn| turn.codex_thread_id == codex_thread_id)
                            .map(|turn| turn.flowix_thread_id.clone())
                    } else {
                        None
                    };
                    let request = CodexApprovalRequest {
                        request_id,
                        method: method.to_string(),
                        flowix_thread_id,
                        thread_id: codex_thread_id,
                        turn_id: request_context(&params, "turnId"),
                        item_id: request_context(&params, "itemId"),
                        params,
                    };
                    if let Some(app) = inner.app_handle.lock().await.clone() {
                        inner.pending_approvals.lock().await.push(request.clone());
                        if let Err(error) = app.emit("codex-approval-request", request) {
                            tracing::warn!("failed to emit Codex approval request: {error}");
                        }
                    } else {
                        write_server_response(&stdin, id, server_decline_result(method)).await;
                    }
                } else {
                    write_server_error(&stdin, id, method).await;
                }
            }
            continue;
        }
        dispatch_notification(&inner, &message).await;
    }
    close_connection(&inner, generation).await;
}

async fn close_connection(inner: &Arc<Inner>, generation: u64) {
    // Keep the connection visible while termination is unconfirmed. Removing it
    // first would allow another app-server to start while the old one still owns
    // native turns, and would release every active run prematurely.
    let mut current = inner.connection.lock().await;
    let Some(connection) = current
        .as_mut()
        .filter(|connection| connection.generation == generation)
    else {
        return;
    };
    if let Err(error) = connection._child.kill().await {
        tracing::warn!("[CodexAppServer] app-server kill request failed: {error}");
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), connection._child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            tracing::warn!("[CodexAppServer] app-server exit unconfirmed: {error}");
            return;
        }
        Err(_) => {
            tracing::warn!("[CodexAppServer] timed out waiting for app-server exit");
            return;
        }
    }
    current.take();
    let pending = std::mem::take(&mut *inner.pending.lock().await);
    inner.pending_approvals.lock().await.clear();
    let active = std::mem::take(&mut *inner.active_turns.lock().await);
    drop(current);
    let manager = CodexAppServerManager {
        inner: inner.clone(),
    };
    let error = "Codex app-server connection closed".to_string();
    for (_, turn) in active {
        if turn.stream_end_emitted.load(Ordering::Acquire) {
            continue;
        }
        if let (Some(command_id), Some(command)) =
            (turn.command_id.as_deref(), turn.command.as_deref())
        {
            manager
                .emit_codex_command(
                    &turn.app_handle,
                    &turn.flowix_thread_id,
                    &turn.run_id,
                    command_id,
                    command,
                    turn.started_at,
                    "error",
                    Some(error.clone()),
                )
                .await;
        }
        manager
            .emit_run_error(
                &turn.app_handle,
                &turn.flowix_thread_id,
                error.clone(),
                &turn.run_id,
            )
            .await;
        manager
            .emit_stream_end(
                &turn.app_handle,
                &turn.flowix_thread_id,
                &turn.run_id,
                Some(error.clone()),
                &turn.stream_end_emitted,
            )
            .await;
    }
    // Wake request callers only after the run's terminal events are emitted.
    // Their error paths inspect stream_end_emitted before reporting an error.
    for (_, sender) in pending {
        let _ = sender.send(Err(error.clone()));
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexApprovalRequest {
    pub request_id: String,
    pub method: String,
    pub flowix_thread_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub params: Value,
}

fn is_user_decision_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
    )
}

fn server_decline_result(method: &str) -> Value {
    if method == "item/permissions/requestApproval" {
        json!({ "permissions": {}, "scope": "turn", "strictAutoReview": null })
    } else {
        json!({ "decision": "decline" })
    }
}

fn request_context(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

async fn write_server_response(stdin: &Arc<Mutex<ChildStdin>>, id: &Value, result: Value) {
    let reply = json!({ "id": id, "result": result });
    if let Ok(encoded) = serde_json::to_string(&reply) {
        let mut writer = stdin.lock().await;
        let _ = writer.write_all(format!("{encoded}\n").as_bytes()).await;
        let _ = writer.flush().await;
    }
}

async fn write_server_error(stdin: &Arc<Mutex<ChildStdin>>, id: &Value, method: &str) {
    let reply = json!({ "id": id, "error": { "code": -32601, "message": format!("Method not found: {method}") } });
    if let Ok(encoded) = serde_json::to_string(&reply) {
        let mut writer = stdin.lock().await;
        let _ = writer.write_all(format!("{encoded}\n").as_bytes()).await;
        let _ = writer.flush().await;
    }
}

fn finish_pending_steer(pending: &mut Vec<Value>, client_id: &str, accepted: bool) {
    if !accepted {
        pending.retain(|item| item["clientUserMessageId"] != client_id);
    } else if let Some(item) = pending
        .iter_mut()
        .find(|item| item["clientUserMessageId"] == client_id)
    {
        item["deliveryStatus"] = json!("steering");
    }
}

fn acknowledge_pending_steers(pending: &mut Vec<Value>, item: &Value) {
    if item.get("type").and_then(Value::as_str) != Some("userMessage") {
        return;
    }
    if let Some(client_id) = item.get("clientId").and_then(Value::as_str) {
        pending.retain(|receipt| {
            receipt.get("clientUserMessageId").and_then(Value::as_str) != Some(client_id)
        });
    }
}

async fn dispatch_notification(inner: &Arc<Inner>, message: &Value) {
    let _dispatch = inner.notification_dispatch.lock().await;
    dispatch_notification_inner(inner, message).await;
}

async fn dispatch_notification_inner(inner: &Arc<Inner>, message: &Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    if method == "thread/settings/updated" {
        // Forward the authoritative App Server settings to the UI. The
        // notification can arrive outside an active turn, so it must not be
        // routed through the turn event path below.
        if let Some(app) = inner.app_handle.lock().await.clone() {
            let _ = app.emit("codex-thread-settings-updated", params.clone());
        }
        return;
    }
    if method == "thread/tokenUsage/updated" {
        if let (Some(thread_id), Some(usage)) = (
            params.get("threadId").and_then(Value::as_str),
            codex_usage_info(params.get("tokenUsage").unwrap_or(&Value::Null)),
        ) {
            inner
                .latest_usage
                .lock()
                .await
                .insert(thread_id.to_string(), usage);
        }
    }
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/threadId").and_then(Value::as_str));
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
    if method == "turn/started" {
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            bind_automatically_started_queue_turn(inner, thread_id, turn_id).await;
        }
    }
    let mut interrupt_target = None;
    let active = {
        let mut turns = inner.active_turns.lock().await;
        // Item lifecycle notifications are turn-scoped. Never fall back to
        // the currently active turn when `turnId` is absent: a late item from
        // the previous turn would otherwise be attributed to the new run on
        // the same Codex thread.
        let requires_exact_turn = turn_scoped_notification(method);
        let found = (thread_id.is_some() || turn_id.is_some())
            && (!requires_exact_turn || (thread_id.is_some() && turn_id.is_some()));
        let waiting_for_start_response =
            if requires_exact_turn && thread_id.is_some() && turn_id.is_some() {
                turns.values_mut().find(|active| {
                    active.codex_turn_id.is_empty()
                        && unbound_notification_action(active.binding, method, true)
                            == UnboundNotificationAction::Buffer
                        && active.binding == TurnBinding::StartResponse
                        && thread_id == Some(active.codex_thread_id.as_str())
                })
            } else {
                None
            };
        if let Some(active) = waiting_for_start_response {
            buffer_turn_notification(active, message);
            return;
        }
        let waiting_for_started_notification = if requires_exact_turn
            && method != "turn/started"
            && thread_id.is_some()
            && turn_id.is_some()
        {
            turns.values_mut().find(|active| {
                active.codex_turn_id.is_empty()
                    && unbound_notification_action(active.binding, method, true)
                        == UnboundNotificationAction::Buffer
                    && active.binding == TurnBinding::StartedNotification
                    && thread_id == Some(active.codex_thread_id.as_str())
            })
        } else {
            None
        };
        if let Some(active) = waiting_for_started_notification {
            buffer_turn_notification(active, message);
            return;
        }
        let mut found = found
            .then(|| {
                turns.values_mut().find(|active| {
                    thread_id
                        .map(|id| id == active.codex_thread_id)
                        .unwrap_or(true)
                        && (active.codex_turn_id.is_empty()
                            || turn_id.map(|id| id == active.codex_turn_id).unwrap_or(true))
                })
            })
            .flatten();
        // Ordinary chats are bound by their own `turn/start` response above.
        // Native asynchronous commands may have no response turn id, so only
        // their `turn/started` notification is allowed to establish identity.
        if let Some(active) = found.as_deref_mut() {
            if active.codex_turn_id.is_empty()
                && active.binding == TurnBinding::StartedNotification
                && method == "turn/started"
            {
                if let Some(turn_id) = turn_id {
                    active.codex_turn_id = turn_id.to_string();
                    active.turn_ready.notify_one();
                }
            }
            if method == "item/completed" {
                if let Some(item) = params.get("item") {
                    acknowledge_pending_steers(&mut active.pending_steers, item);
                }
            }
            if active.cancel_requested && !active.codex_turn_id.is_empty() {
                // `dispatch_notification` runs on the app-server reader task;
                // waiting here for the interrupt response would deadlock that
                // reader. Schedule it after releasing the registry lock.
                active.cancel_requested = false;
                interrupt_target =
                    Some((active.codex_thread_id.clone(), active.codex_turn_id.clone()));
            }
        }
        found.map(|active| {
            active.last_event_at = chrono::Utc::now().timestamp_millis();
            (
                active.flowix_thread_id.clone(),
                active.run_id.clone(),
                active.app_handle.clone(),
                active.stream_end_emitted.clone(),
                active.completed_agent_messages.clone(),
                active.command_id.clone(),
                active.command.clone(),
                active.started_at,
                if method == "turn/started" {
                    std::mem::take(&mut active.pending_notifications)
                } else {
                    Vec::new()
                },
            )
        })
    };
    let Some((
        flowix_thread_id,
        run_id,
        app,
        ended,
        completed_agent_messages,
        command_id,
        command,
        started_at,
        pending,
    )) = active
    else {
        return;
    };
    for notification in pending {
        Box::pin(dispatch_notification_inner(inner, &notification)).await;
    }
    if let Some((codex_thread_id, codex_turn_id)) = interrupt_target {
        let inner = inner.clone();
        tokio::spawn(async move {
            let _ = request_inner(
                &inner,
                "turn/interrupt",
                json!({ "threadId": codex_thread_id, "turnId": codex_turn_id }),
            )
            .await;
        });
    }
    match method {
        "turn/started" => {}
        "thread/tokenUsage/updated" => {
            let token_usage = params.get("tokenUsage").unwrap_or(&Value::Null);
            let last = token_usage
                .get("last")
                .or_else(|| token_usage.get("lastTokenUsage"))
                .and_then(codex_usage_info);
            if let Some(usage) = last {
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Usage {
                        thread_id: flowix_thread_id.clone(),
                        model_id: None,
                        last_run_at: None,
                        usage: Some(usage),
                        status_info: None,
                    },
                )
                .await;
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Text {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    with_turn_id(item_delta_metadata(params), turn_id.as_deref()),
                )
                .await;
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            if let Some(delta) = params
                .get("delta")
                .and_then(Value::as_str)
                .filter(|delta| has_visible_text(delta))
            {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Reasoning {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    with_turn_id(item_delta_metadata(params), turn_id.as_deref()),
                )
                .await;
            }
        }
        "item/started" => {
            if let Some(item) = params.get("item") {
                if let Some((chunk, metadata)) =
                    tool_call_notification_chunk(&flowix_thread_id, item, turn_id)
                {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        chunk,
                        metadata,
                    )
                    .await;
                }
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                if let Some((chunk, metadata)) =
                    completed_message_chunk(&flowix_thread_id, item, turn_id.as_deref())
                {
                    let mut metadata = metadata;
                    if should_emit_completed_agent_message(
                        &completed_agent_messages,
                        item,
                        turn_id.as_deref(),
                        None,
                        &mut metadata,
                    )
                    .await
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                } else if is_custom_tool_call_item(item) {
                    // Some App Server versions only expose the completed
                    // snapshot for custom tools. Replaying the call is
                    // idempotent with item/started and preserves a visible
                    // row when that notification was absent.
                    if let Some((chunk, metadata)) =
                        tool_call_notification_chunk(&flowix_thread_id, item, turn_id)
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                    if let Some((chunk, metadata)) =
                        tool_result_notification_chunk(&flowix_thread_id, item, turn_id)
                    {
                        emit_notification_chunk_with_metadata(
                            inner,
                            &flowix_thread_id,
                            &run_id,
                            &app,
                            chunk,
                            metadata,
                        )
                        .await;
                    }
                } else if let Some((chunk, metadata)) =
                    tool_result_notification_chunk(&flowix_thread_id, item, turn_id)
                {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        chunk,
                        metadata,
                    )
                    .await;
                }
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let reason = match status {
                "completed" => None,
                "interrupted" => Some(USER_STOPPED_REASON.to_string()),
                _ => Some(
                    params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed")
                        .to_string(),
                ),
            };
            if ended
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                // App Server normally finalizes messages through item/completed.
                // The completed turn also carries the final agent message, so
                // project it as an idempotent fallback before ending the stream.
                if let Some(items) = params.pointer("/turn/items").and_then(Value::as_array) {
                    if let Some((item_index, item)) =
                        items.iter().enumerate().rev().find(|(_, item)| {
                            item.get("type").and_then(Value::as_str) == Some("agentMessage")
                        })
                    {
                        if let Some((chunk, metadata)) =
                            completed_message_chunk(&flowix_thread_id, item, turn_id.as_deref())
                        {
                            let occurrence =
                                codex_fallback_agent_message_occurrence(items, item_index, status);
                            let mut metadata = metadata;
                            if should_emit_completed_agent_message(
                                &completed_agent_messages,
                                item,
                                turn_id.as_deref(),
                                Some(occurrence),
                                &mut metadata,
                            )
                            .await
                            {
                                emit_notification_chunk_with_metadata(
                                    inner,
                                    &flowix_thread_id,
                                    &run_id,
                                    &app,
                                    chunk,
                                    metadata,
                                )
                                .await;
                            }
                        }
                    }
                }
                if let Some(reason) = &reason {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::Error {
                            thread_id: flowix_thread_id.clone(),
                            message: reason.clone(),
                            error_details: Some(crate::agent_external::classify_agent_error(
                                reason,
                                "app-server",
                            )),
                        },
                        codex_turn_error_metadata(turn_id.as_deref()),
                    )
                    .await;
                }
                if let (Some(command_id), Some(command)) =
                    (command_id.as_deref(), command.as_deref())
                {
                    let status = if reason.as_deref() == Some(USER_STOPPED_REASON) {
                        "cancelled"
                    } else if reason.is_some() {
                        "error"
                    } else {
                        "success"
                    };
                    emit_codex_command_notification(
                        &app,
                        &flowix_thread_id,
                        &run_id,
                        command_id,
                        command,
                        started_at,
                        status,
                        reason.clone(),
                        turn_id,
                    )
                    .await;
                }
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::StreamEnd {
                        thread_id: flowix_thread_id.clone(),
                        reason,
                        duration_ms: params.pointer("/turn/durationMs").and_then(Value::as_u64),
                    },
                )
                .await;
            }
            let mut turns = inner.active_turns.lock().await;
            if turns.get(&flowix_thread_id).is_some_and(|active| {
                active.run_id == run_id && turn_id.is_some_and(|id| id == active.codex_turn_id)
            }) {
                turns.remove(&flowix_thread_id);
            }
        }
        _ => {}
    }
}

fn codex_usage_info(value: &Value) -> Option<crate::agent_types::UsageInfo> {
    let source = value
        .get("total")
        .or_else(|| value.get("totalTokenUsage"))
        .unwrap_or(value);
    let number = |key: &str| {
        source
            .get(key)
            .and_then(Value::as_u64)
            .map(|n| n.min(u32::MAX as u64) as u32)
    };
    let context = value
        .get("modelContextWindow")
        .or_else(|| value.get("model_context_window"))
        .and_then(Value::as_u64)
        .map(|n| n.min(u32::MAX as u64) as u32);
    if number("inputTokens").is_none()
        && number("input_tokens").is_none()
        && number("outputTokens").is_none()
        && number("output_tokens").is_none()
        && context.is_none()
    {
        return None;
    }
    Some(crate::agent_types::UsageInfo {
        input_tokens: number("inputTokens").or_else(|| number("input_tokens")),
        cached_input_tokens: number("cachedInputTokens").or_else(|| number("cached_input_tokens")),
        output_tokens: number("outputTokens").or_else(|| number("output_tokens")),
        reasoning_output_tokens: number("reasoningOutputTokens")
            .or_else(|| number("reasoning_output_tokens")),
        total_tokens: number("totalTokens").or_else(|| number("total_tokens")),
        model_context_window: context,
        context_used_tokens: None,
    })
}

fn turn_scoped_notification(method: &str) -> bool {
    matches!(
        method,
        "turn/started"
            | "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/started"
            | "item/completed"
            | "turn/completed"
    )
}

async fn emit_notification_chunk(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
) {
    emit_chunk_with_run_id(app, &chunk, AGENT_TYPE, run_id);
}

async fn emit_codex_command_notification(
    app: &tauri::AppHandle,
    thread_id: &str,
    run_id: &str,
    command_id: &str,
    command: &str,
    timestamp: i64,
    status: &str,
    result: Option<String>,
    turn_id: Option<&str>,
) {
    let chunk = AgentChunk::CodexCommand {
        thread_id: thread_id.to_string(),
        id: command_id.to_string(),
        command: command.to_string(),
        status: status.to_string(),
        result,
        timestamp,
    };
    let metadata = with_turn_id(AgentChunkMetadata::default(), turn_id);
    emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
}

async fn emit_notification_chunk_with_metadata(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
    metadata: AgentChunkMetadata,
) {
    emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
}

fn item_delta_metadata(params: &Value) -> AgentChunkMetadata {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    item_metadata_from_id(item_id)
}

fn item_metadata(item: &Value) -> AgentChunkMetadata {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    let mut metadata = item_metadata_from_id(item_id);
    metadata.codex_turn_id = item
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    metadata.client_user_message_id = item
        .get("clientId")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata
}

fn item_metadata_from_id(item_id: Option<String>) -> AgentChunkMetadata {
    AgentChunkMetadata {
        message_id: item_id.clone(),
        source_message_id: item_id,
        ..AgentChunkMetadata::default()
    }
}

fn completed_agent_message(item: &Value) -> Option<CompletedAgentMessageCandidate> {
    if item.get("type").and_then(Value::as_str) != Some("agentMessage") {
        return None;
    }
    let message = CompletedAgentMessageCandidate {
        id: item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string),
        text: item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    (!message.text.trim().is_empty()).then_some(message)
}

async fn should_emit_completed_agent_message(
    messages: &Arc<Mutex<Vec<SeenCompletedAgentMessage>>>,
    item: &Value,
    turn_id: Option<&str>,
    terminal_occurrence: Option<usize>,
    metadata: &mut AgentChunkMetadata,
) -> bool {
    let Some(candidate) = completed_agent_message(item) else {
        return true;
    };
    let mut seen = messages.lock().await;
    let fallback_occurrence = candidate.id.is_none().then(|| {
        terminal_occurrence.unwrap_or_else(|| {
            seen.iter()
                .filter(|previous| previous.id.is_none() && previous.text == candidate.text)
                .count()
        })
    });
    let duplicate_id = candidate.id.as_deref().is_some_and(|candidate_id| {
        seen.iter()
            .any(|previous| previous.id.as_deref() == Some(candidate_id))
    });
    let terminal_duplicate = terminal_occurrence.is_some_and(|occurrence| {
        seen.iter().any(|previous| {
            previous.id.is_none()
                && previous.text == candidate.text
                && previous.fallback_occurrence == Some(occurrence)
        })
    });
    if duplicate_id || terminal_duplicate {
        return false;
    }

    if metadata.message_id.is_none() {
        metadata.message_id = candidate.id.clone().or_else(|| {
            let occurrence = fallback_occurrence.unwrap_or_default();
            turn_id.filter(|id| !id.trim().is_empty()).map(|turn_id| {
                codex_fallback_item_message_id(turn_id, "assistant", &candidate.text, occurrence)
            })
        });
    }
    seen.push(SeenCompletedAgentMessage {
        id: candidate.id,
        text: candidate.text,
        fallback_occurrence,
    });
    true
}

fn codex_fallback_agent_message_occurrence(
    items: &[Value],
    item_index: usize,
    turn_status: &str,
) -> usize {
    let Some(item) = items.get(item_index) else {
        return 0;
    };
    let Some(text) = item.get("text").and_then(Value::as_str) else {
        return 0;
    };
    let interrupted_turn = matches!(turn_status, "failed" | "interrupted" | "cancelled");
    items[..item_index]
        .iter()
        .filter(|previous| {
            if previous.get("type").and_then(Value::as_str) != Some("agentMessage")
                || previous
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty())
                || previous.get("text").and_then(Value::as_str) != Some(text)
            {
                return false;
            }
            let interrupted_item =
                previous
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        matches!(
                            status,
                            "inProgress" | "failed" | "interrupted" | "cancelled"
                        )
                    });
            !(interrupted_turn && interrupted_item)
        })
        .count()
}

fn with_turn_id(mut metadata: AgentChunkMetadata, turn_id: Option<&str>) -> AgentChunkMetadata {
    metadata.codex_turn_id = turn_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    metadata
}

fn tool_call_notification_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let (id, name) = codex_tool_call_identity(item)?;
    let mut metadata = with_turn_id(item_metadata(item), turn_id);
    metadata.message_type = codex_custom_tool_message_type(item);
    Some((
        AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input: codex_tool_call_input(item),
        },
        metadata,
    ))
}

fn tool_result_notification_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let (id, name) = codex_tool_result_identity(item)?;
    let result = codex_tool_result_value(item)?;
    let mut metadata = with_turn_id(item_metadata(item), turn_id);
    metadata.message_type = codex_custom_tool_message_type(item);
    Some((
        AgentChunk::ToolResult {
            thread_id: thread_id.to_string(),
            id,
            name,
            result,
        },
        metadata,
    ))
}

fn completed_message_chunk(
    thread_id: &str,
    item: &Value,
    turn_id: Option<&str>,
) -> Option<(AgentChunk, AgentChunkMetadata)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    if kind == "contextCompaction" {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                turn_id
                    .filter(|id| !id.trim().is_empty())
                    .map(|turn_id| codex_fallback_item_message_id(turn_id, "system", "", 0))
            })
            .unwrap_or_else(|| "codex-context-compaction".to_string());
        let mut metadata = item_metadata(item);
        metadata.codex_turn_id = turn_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        metadata.message_phase = Some("completed");
        metadata.content_mode = Some("snapshot");
        return Some((
            AgentChunk::ContextCompaction {
                thread_id: thread_id.to_string(),
                id,
            },
            metadata,
        ));
    }

    let raw_text = match kind {
        // Relay every completed userMessage item, not just steers. The
        // provider item id turns the optimistic `user-<run>` row into a
        // history-stable identity mid-turn (the frontend adopts it in
        // place), so completion reconciliation can anchor by id instead of
        // content fingerprints. Steer items additionally carry clientId so
        // the frontend can reconcile the pending composer row.
        "userMessage" => app_server_content_text(item.get("content")),
        "agentMessage" => item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "reasoning" => {
            let summary = app_server_content_text(item.get("summary"));
            if summary.is_empty() {
                app_server_content_text(item.get("content"))
            } else {
                summary
            }
        }
        _ => return None,
    };
    // Native commands are represented by `CodexCommand` below. Some server
    // versions echo the slash text as a completed user item; suppress that
    // echo so the product-owned command row is not duplicated.
    if kind == "userMessage"
        && (is_codex_native_command_text(&raw_text) || is_codex_goal_internal_context(&raw_text))
    {
        return None;
    }
    let text = if kind == "userMessage" {
        visible_user_text(&raw_text)
    } else {
        raw_text
    };
    if !has_visible_text(&text) {
        return None;
    }
    let chunk = if kind == "userMessage" {
        let user_id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .unwrap_or(CODEX_MISSING_USER_ITEM_ID)
            .to_string();
        AgentChunk::UserMessage {
            thread_id: thread_id.to_string(),
            id: user_id,
            text,
            timestamp: chrono::Utc::now().timestamp_millis(),
            attachments: app_server_image_attachments(item.get("content")),
        }
    } else if kind == "agentMessage" {
        AgentChunk::Text {
            thread_id: thread_id.to_string(),
            text,
        }
    } else {
        AgentChunk::Reasoning {
            thread_id: thread_id.to_string(),
            text,
        }
    };
    let mut metadata = item_metadata(item);
    metadata.codex_turn_id = turn_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    metadata.message_type = codex_message_type(item);
    // Completed item notifications do not repeat turnId in the item. The
    // caller fills it from the notification context before emitting.
    metadata.message_phase = Some("completed");
    metadata.content_mode = Some("snapshot");
    Some((chunk, metadata))
}

fn is_codex_native_command_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower == "/compact"
        || lower.starts_with("/goal")
            && lower
                .as_bytes()
                .get(5)
                .is_none_or(|byte| byte.is_ascii_whitespace())
}

fn is_codex_goal_internal_context(text: &str) -> bool {
    text.trim_start()
        .starts_with("<codex_internal_context source=\"goal\">")
}

/// A newly-created goal turn has no persisted `/goal ...` user item. Codex
/// stores the user-provided objective inside a hidden internal-context item
/// instead. Reconstruct the product-owned command only for the first goal
/// turn (`Tokens used: 0`); later autonomous continuation turns carry the
/// same objective and must not create duplicate user commands.
fn initial_goal_objective(turn: &Value) -> Option<String> {
    if let Some(objective) = turn
        .get("flowixGoalObjective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|objective| !objective.is_empty())
    {
        return Some(objective.to_string());
    }
    let text = turn
        .get("items")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
        .map(|item| app_server_content_text(item.get("content")))
        .find(|text| is_codex_goal_internal_context(text))?;
    if !text.lines().any(|line| line.trim() == "- Tokens used: 0") {
        return None;
    }
    let start = text.find("<objective>")? + "<objective>".len();
    let end = text[start..].find("</objective>")? + start;
    let objective = text[start..end].trim();
    (!objective.is_empty()).then(|| objective.to_string())
}

fn annotate_goal_turn(turns: &mut [Value], response: &Value) {
    let goal = response.get("goal").unwrap_or(&Value::Null);
    let Some(objective) = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|objective| !objective.is_empty())
    else {
        return;
    };
    let Some(created_at) = goal.get("createdAt").and_then(Value::as_i64) else {
        return;
    };
    let updated_at = goal
        .get("updatedAt")
        .and_then(Value::as_i64)
        .unwrap_or(created_at);
    // Editing an existing goal retains its original createdAt. updatedAt is
    // written while the new autonomous turn is running, so its containing
    // turn is the authoritative owner of the latest `/goal ...` command.
    let updated_candidate = turns.iter().position(|turn| {
        let Some(started_at) = turn.get("startedAt").and_then(Value::as_i64) else {
            return false;
        };
        let completed_at = turn
            .get("completedAt")
            .and_then(Value::as_i64)
            .unwrap_or_else(|| started_at.saturating_add(5));
        updated_at >= started_at.saturating_sub(2) && updated_at <= completed_at.saturating_add(2)
    });
    // Before a goal's first status update, createdAt and turn/start are
    // emitted together. Keep a narrowly-bounded creation-time fallback.
    let candidate_index = updated_candidate.or_else(|| {
        turns
            .iter()
            .enumerate()
            .filter_map(|(index, turn)| {
                let started_at = turn.get("startedAt").and_then(Value::as_i64)?;
                let distance = started_at.abs_diff(created_at);
                (distance <= 5).then_some((distance, index))
            })
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, index)| index)
    });
    let Some(Value::Object(turn)) = candidate_index.and_then(|index| turns.get_mut(index)) else {
        return;
    };
    turn.insert(
        "flowixGoalObjective".to_string(),
        Value::String(objective.to_string()),
    );
}

/// Translate Flowix permission names into the App Server sandbox object.
/// Keep this separate from the App Server v2 `permissions` profile API.
fn app_server_sandbox(permission: Option<&str>) -> Value {
    app_server_sandbox_with_roots(permission, &[])
}

fn app_server_sandbox_with_roots(permission: Option<&str>, writable_roots: &[String]) -> Value {
    match permission.map(str::trim) {
        Some("read-only") => json!({ "type": "readOnly" }),
        Some("danger-full-access" | "yolo") => json!({ "type": "dangerFullAccess" }),
        None | Some("workspace-write") => json!({
            "type": "workspaceWrite",
            "writableRoots": writable_roots,
            "networkAccess": false
        }),
        _ => json!({ "type": "readOnly" }),
    }
}

/// `thread/start` uses the legacy kebab-case sandbox field. Keep this mapping
/// separate from the object form used by `turn/start` and settings updates.
fn app_server_legacy_sandbox(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        Some("read-only") => "read-only",
        Some("danger-full-access" | "yolo") => "danger-full-access",
        None | Some("workspace-write") => "workspace-write",
        _ => "read-only",
    }
}

fn app_server_approval_policy(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        None | Some("workspace-write") => "on-request",
        _ => "never",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_cancellation_is_scoped_and_consumed_once() {
        let mut pending = HashMap::from([
            ("thread-a".to_string(), "run-a".to_string()),
            ("thread-b".to_string(), "run-b".to_string()),
        ]);
        assert!(take_pending_cancellation(&mut pending, "thread-a", "run-a"));
        assert!(!take_pending_cancellation(
            &mut pending,
            "thread-a",
            "run-a"
        ));
        assert!(!take_pending_cancellation(
            &mut pending,
            "thread-b",
            "new-run"
        ));
        assert!(
            pending.is_empty(),
            "a stale Stop must not cancel a later run"
        );
    }

    #[test]
    fn consumes_only_the_correlated_pending_steer_and_never_recreates_a_receipt() {
        let mut receipts = vec![
            json!({ "clientUserMessageId": "first", "deliveryStatus": "submitting" }),
            json!({ "clientUserMessageId": "second", "deliveryStatus": "steering" }),
        ];
        acknowledge_pending_steers(
            &mut receipts,
            &json!({ "type": "agentMessage", "clientId": "first" }),
        );
        assert_eq!(receipts.len(), 2);
        acknowledge_pending_steers(
            &mut receipts,
            &json!({ "type": "userMessage", "clientId": "first" }),
        );
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0]["clientUserMessageId"], "second");
        finish_pending_steer(&mut receipts, "first", true);
        assert_eq!(receipts.len(), 1);
        acknowledge_pending_steers(
            &mut receipts,
            &json!({ "type": "userMessage", "clientId": "first" }),
        );
        assert_eq!(receipts.len(), 1);
    }

    #[test]
    fn identifies_queue_entries_already_consumed_by_codex() {
        assert!(is_stale_queued_submission_error(
            "queued submission not found: 01a12a9e-d74e-7b71-8771-78cd958e8a72"
        ));
        assert!(!is_stale_queued_submission_error("turn is still active"));
        assert!(is_queue_start_conflict_error(
            "thread already has an active or pending turn"
        ));
    }

    #[test]
    fn reads_queued_submission_content_for_automatic_turn_binding() {
        let queued = queued_follow_up_from_submission(
            "flowix-thread",
            "codex-thread",
            &json!({
                "id": "provider-queue-id",
                "clientUserMessageId": "flowix-user-id",
                "input": [
                    { "type": "text", "text": "follow-up request" },
                    { "type": "localImage", "path": "/tmp/reference.png" }
                ]
            }),
        )
        .unwrap();

        assert_eq!(queued.flowix_thread_id, "flowix-thread");
        assert_eq!(queued.codex_thread_id, "codex-thread");
        assert_eq!(
            queued.queued_submission_id.as_deref(),
            Some("provider-queue-id")
        );
        assert_eq!(queued.client_user_message_id, "flowix-user-id");
        assert_eq!(queued.message.content, "follow-up request");
        assert_eq!(queued.message.image_paths, vec!["/tmp/reference.png"]);
    }

    #[test]
    fn selects_the_oldest_provider_submission_when_starting_an_idle_queue() {
        let queue = json!({
            "data": [
                {
                    "id": "older-queue-id",
                    "clientUserMessageId": "older-client-id",
                    "input": [{ "type": "text", "text": "older follow-up" }]
                },
                {
                    "id": "newer-queue-id",
                    "clientUserMessageId": "newer-client-id",
                    "input": [{ "type": "text", "text": "newer follow-up" }]
                }
            ]
        });

        let head = queued_follow_up_at_queue_head("flowix-thread", "codex-thread", &queue).unwrap();

        assert_eq!(head.queued_submission_id.as_deref(), Some("older-queue-id"));
        assert_eq!(head.client_user_message_id, "older-client-id");
        assert_eq!(head.message.content, "older follow-up");
    }

    #[test]
    fn aligns_local_turn_binding_order_with_the_provider_queue() {
        let mut items = vec![
            queued_follow_up_from_submission(
                "flowix-thread",
                "codex-thread",
                &json!({
                    "id": "newer-queue-id",
                    "clientUserMessageId": "newer-client-id",
                    "input": [{ "type": "text", "text": "newer follow-up" }]
                }),
            )
            .unwrap(),
            queued_follow_up_from_submission(
                "flowix-thread",
                "codex-thread",
                &json!({
                    "id": "older-queue-id",
                    "clientUserMessageId": "older-client-id",
                    "input": [{ "type": "text", "text": "older follow-up" }]
                }),
            )
            .unwrap(),
        ];

        order_queued_follow_ups(
            &mut items,
            &["older-queue-id".to_string(), "newer-queue-id".to_string()],
        );

        assert_eq!(
            items
                .iter()
                .map(|item| item.client_user_message_id.as_str())
                .collect::<Vec<_>>(),
            ["older-client-id", "newer-client-id"],
        );
    }

    #[test]
    fn compares_codex_cli_versions_numerically() {
        let minimum = parse_codex_version(MIN_PAGINATED_CODEX_VERSION).unwrap();
        assert!(parse_codex_version("0.150.0").unwrap() >= minimum);
        assert!(parse_codex_version("0.152.0").unwrap() > minimum);
        assert!(parse_codex_version("0.149.99").unwrap() < minimum);
        assert_eq!(parse_codex_version("0.150.0-beta.1").unwrap(), minimum);
        assert!(parse_codex_version("not-a-version").is_none());
    }

    #[test]
    fn projects_known_tool_items_to_stable_flowix_names() {
        let item = json!({
            "id": "item-1",
            "type": "commandExecution",
            "command": "git status --short"
        });
        assert_eq!(
            codex_tool_call_identity(&item),
            Some(("item-1".to_string(), "command_execution".to_string()))
        );
    }

    #[test]
    fn accepts_current_app_server_tool_item_names() {
        let collab = json!({ "id": "item-c", "type": "collabToolCall", "tool": "spawn_agent" });
        let image_view =
            json!({ "id": "item-view", "type": "imageView", "path": "/tmp/image.png" });
        let image_generation = json!({ "id": "item-generation", "type": "imageGeneration" });

        assert_eq!(
            codex_tool_call_identity(&collab),
            Some(("item-c".to_string(), "collab_agent_tool_call".to_string()))
        );
        assert_eq!(
            codex_tool_call_identity(&image_view),
            Some(("item-view".to_string(), "view_image".to_string()))
        );
        assert_eq!(
            codex_tool_call_identity(&image_generation),
            Some((
                "item-generation".to_string(),
                "image_generation".to_string()
            ))
        );
    }

    #[test]
    fn serializes_app_server_sandbox_objects() {
        assert_eq!(
            app_server_sandbox(Some("unknown-mode")),
            json!({ "type": "readOnly" })
        );
        assert_eq!(app_server_approval_policy(Some("unknown-mode")), "never");
        assert_eq!(
            app_server_sandbox(Some("read-only")),
            json!({ "type": "readOnly" })
        );
        assert_eq!(
            app_server_sandbox(Some("danger-full-access")),
            json!({ "type": "dangerFullAccess" })
        );
        assert_eq!(
            app_server_sandbox(Some("yolo")),
            json!({ "type": "dangerFullAccess" })
        );
        assert_eq!(
            app_server_sandbox(None),
            json!({
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": false
            })
        );
    }

    #[test]
    fn serializes_legacy_thread_start_sandbox_values() {
        assert_eq!(app_server_legacy_sandbox(Some("unknown-mode")), "read-only");
        assert_eq!(app_server_legacy_sandbox(Some("read-only")), "read-only");
        assert_eq!(
            app_server_legacy_sandbox(Some("workspace-write")),
            "workspace-write"
        );
        assert_eq!(app_server_legacy_sandbox(None), "workspace-write");
        assert_eq!(
            app_server_legacy_sandbox(Some("danger-full-access")),
            "danger-full-access"
        );
        assert_eq!(
            app_server_legacy_sandbox(Some("yolo")),
            "danger-full-access"
        );
    }

    #[test]
    fn enables_interactive_approval_only_for_writable_threads() {
        assert_eq!(
            app_server_approval_policy(Some("workspace-write")),
            "on-request"
        );
        assert_eq!(app_server_approval_policy(None), "on-request");
        assert_eq!(app_server_approval_policy(Some("read-only")), "never");
        assert_eq!(
            app_server_approval_policy(Some("danger-full-access")),
            "never"
        );
    }

    #[test]
    fn uses_current_codex_review_decision_wire_values() {
        assert_eq!(
            server_decline_result("item/commandExecution/requestApproval"),
            json!({ "decision": "decline" })
        );
        assert_eq!(
            server_decline_result("item/permissions/requestApproval"),
            json!({ "permissions": {}, "scope": "turn", "strictAutoReview": null })
        );
    }

    #[test]
    fn ignores_non_tool_items() {
        assert_eq!(
            codex_tool_call_identity(&json!({ "id": "message-1", "type": "agentMessage" })),
            None
        );
    }

    #[test]
    fn projects_codex_commentary_as_agent_message_type() {
        let message = app_server_item_message(
            &json!({
                "id": "commentary-1",
                "type": "agentMessage",
                "text": "Checking the workspace.",
                "phase": "commentary"
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            Some("turn-1"),
        )
        .expect("commentary message");

        assert_eq!(message.role, "assistant");
        assert_eq!(
            message.message_type.as_deref(),
            Some(CODEX_COMMENTARY_MESSAGE_TYPE)
        );
    }

    #[test]
    fn strips_workspace_context_from_codex_history_user_message() {
        let message = app_server_item_message(
            &json!({
                "id": "user-1",
                "type": "userMessage",
                "content": "question\n<## CONTEXT PROMPT ##>\nprivate workspace data"
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            Some("turn-1"),
        )
        .expect("user message");

        assert_eq!(message.content, "question");
    }

    #[test]
    fn ignores_empty_reasoning_items() {
        let message = app_server_item_message(
            &json!({
                "id": "reasoning-empty",
                "type": "reasoning",
                "summary": [" ", "\n"]
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            None,
        );
        assert!(message.is_none());
        assert!(!has_visible_text(" \n\t"));
        assert!(has_visible_text("plan"));
    }

    #[test]
    fn projects_context_compaction_as_a_system_message() {
        let message = app_server_item_message(
            &json!({
                "id": "compaction-1",
                "type": "contextCompaction"
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            Some("turn-1"),
        )
        .expect("context compaction");

        assert_eq!(message.role, "system");
        assert_eq!(
            message.message_type.as_deref(),
            Some(CONTEXT_COMPACTION_MESSAGE_TYPE)
        );
        assert_eq!(message.codex_turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn context_compaction_without_native_identity_uses_the_live_fallback() {
        let messages = app_server_turn_messages(&[json!({
            "status": "completed",
            "items": [{ "type": "contextCompaction" }]
        })]);

        let marker = messages
            .iter()
            .find(|message| message.role == "system")
            .expect("context compaction marker");
        assert_eq!(marker.id, "codex-context-compaction");
    }

    #[test]
    fn codex_history_only_confirms_assistant_rows_with_native_terminal_evidence() {
        let active = app_server_turn_messages(&[json!({
            "id": "turn-active", "status": "inProgress",
            "items": [
                { "id": "reply-active", "type": "agentMessage", "text": "partial" },
                { "id": "reasoning-active", "type": "reasoning", "summary": "thinking" }
            ]
        })]);
        assert!(active
            .iter()
            .all(|message| message.is_completed == Some(false)));

        let completed_item = app_server_turn_messages(&[json!({
            "id": "turn-active", "status": "inProgress",
            "items": [{ "id": "reply-complete", "type": "agentMessage", "status": "completed", "text": "stable" }]
        })]);
        assert_eq!(completed_item[0].is_completed, Some(true));

        let page = paginate_app_server_turns(
            &[
                json!({ "id": "turn-done", "status": "completed", "items": [] }),
                json!({ "id": "turn-active", "status": "inProgress", "items": [] }),
            ],
            None,
            None,
            10,
        );
        assert_eq!(page.complete_turn_ids, Some(vec!["turn-done".to_string()]));

        let finished = app_server_turn_messages(&[json!({
            "id": "turn-finished", "status": "completed",
            "items": [
                { "id": "reply-finished", "type": "agentMessage", "text": "done" },
                { "id": "reasoning-finished", "type": "reasoning", "summary": "thought" }
            ]
        })]);
        assert!(finished
            .iter()
            .all(|message| message.is_completed == Some(true)));
    }

    #[test]
    fn restores_manual_compact_as_a_history_user_message() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-compact",
            "startedAt": 1_730_910_000,
            "status": "completed",
            "items": [{
                "id": "compaction-1",
                "type": "contextCompaction"
            }]
        })]);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "/compact");
        assert_eq!(
            messages[0].message_type.as_deref(),
            Some(CODEX_COMMAND_MESSAGE_TYPE)
        );
        assert_eq!(
            messages[0].id,
            codex_command_message_id(Some("turn-compact"), "")
        );
        assert_eq!(messages[0].id, "flowix:codex:command:turn-compact");
        assert_eq!(messages[0].codex_turn_id.as_deref(), Some("turn-compact"));
        assert_eq!(messages[1].role, "system");
        assert_eq!(
            messages[1].message_type.as_deref(),
            Some(CONTEXT_COMPACTION_MESSAGE_TYPE)
        );
    }

    #[test]
    fn history_commands_without_turn_ids_use_the_unbound_namespace() {
        let compact = app_server_compact_command_message(
            &json!({ "id": "compact-item", "type": "contextCompaction" }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            None,
        );
        let goal = app_server_goal_command_message("Ship it", "2026-01-01T00:00:00Z", 2, None);

        assert_eq!(compact.id, "flowix:codex:command:unbound:compact-item");
        assert_eq!(goal.id, "flowix:codex:command:unbound:turn-2");
    }

    #[test]
    fn codex_missing_item_ids_use_turn_content_and_occurrence() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-fallback",
            "status": "completed",
            "items": [
                { "type": "agentMessage", "text": "same reply" },
                { "type": "agentMessage", "text": "same reply" },
                { "type": "reasoning", "summary": "same thought" },
                { "type": "reasoning", "summary": "same thought" }
            ]
        })]);

        assert_eq!(messages.len(), 4);
        assert_eq!(
            messages[0].id,
            codex_fallback_item_message_id("turn-fallback", "assistant", "same reply", 0)
        );
        assert_eq!(
            messages[0].id,
            "flowix:codex:item:turn-fallback:assistant:c9c3d78b64eaec57:0"
        );
        assert_eq!(
            codex_fallback_item_message_id("t", "assistant", "你好🙂", 0),
            "flowix:codex:item:t:assistant:71b13a3934f0304d:0"
        );
        assert_eq!(
            messages[1].id,
            codex_fallback_item_message_id("turn-fallback", "assistant", "same reply", 1)
        );
        assert_ne!(messages[0].id, messages[1].id);
        assert_eq!(
            messages[2].id,
            codex_fallback_item_message_id("turn-fallback", "reasoning", "same thought", 0)
        );
        assert_eq!(
            messages[3].id,
            codex_fallback_item_message_id("turn-fallback", "reasoning", "same thought", 1)
        );
    }

    #[test]
    fn repeated_codex_user_items_without_ids_match_the_live_fallback_policy() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-users",
            "status": "completed",
            "items": [
                { "type": "userMessage", "content": "repeat" },
                { "type": "userMessage", "content": "repeat" }
            ]
        })]);

        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].id,
            codex_fallback_item_message_id("turn-users", "user", "repeat", 0)
        );
        assert_eq!(
            messages[1].id,
            codex_fallback_item_message_id("turn-users", "user", "repeat", 1)
        );
    }

    #[test]
    fn orphan_custom_tool_history_uses_provider_output_id_or_call_fallback() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-tools",
            "status": "completed",
            "items": [
                { "id": "output-item", "type": "custom_tool_call_output", "call_id": "call-a", "output": "done" },
                { "type": "custom_tool_call_output", "call_id": "call-b", "output": "done" }
            ]
        })]);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].id, "output-item");
        assert_eq!(
            messages[1].id,
            codex_custom_tool_output_message_id(Some("turn-tools"), "call-b")
        );
        assert_eq!(messages[1].id, "flowix:codex:tool-output:turn-tools:call-b");
    }

    #[test]
    fn custom_tool_call_without_item_id_uses_the_live_call_fallback() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-tools",
            "status": "completed",
            "items": [{
                "type": "custom_tool_call",
                "call_id": "call-a",
                "name": "future_connector",
                "input": { "query": "x" }
            }]
        })]);

        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].id,
            codex_tool_call_message_id(Some("turn-tools"), "call-a")
        );
        assert_eq!(messages[0].id, "flowix:codex:tool-call:turn-tools:call-a");
        assert_eq!(messages[0].tool_call_id.as_deref(), Some("call-a"));
    }

    #[test]
    fn codex_tool_call_without_turn_or_item_id_uses_the_unbound_live_fallback() {
        let messages = app_server_turn_messages(&[json!({
            "status": "completed",
            "items": [{
                "type": "custom_tool_call",
                "call_id": "call-a",
                "name": "future_connector",
                "input": { "query": "x" }
            }]
        })]);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, codex_tool_call_message_id(None, "call-a"));
        assert_eq!(messages[0].id, "flowix:codex:tool-call:unbound:call-a");
    }

    #[test]
    fn cancelled_turn_history_emits_the_same_error_identity_as_live() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-cancelled",
            "status": "cancelled",
            "items": []
        })]);

        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].id,
            codex_turn_error_message_id("turn-cancelled")
        );
        assert_eq!(messages[0].content, "Codex turn failed");
    }

    #[test]
    fn restores_initial_goal_command_before_goal_tools_and_hides_internal_context() {
        let internal = r#"<codex_internal_context source="goal">
<objective>
Analyze the project briefly
</objective>
Budget:
- Tokens used: 0
</codex_internal_context>"#;
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-goal",
            "startedAt": 1_730_910_000,
            "status": "completed",
            "items": [
                { "id": "goal-context", "type": "userMessage", "content": internal },
                {
                    "id": "exec-1",
                    "type": "commandExecution",
                    "command": "rg --files",
                    "aggregatedOutput": "Cargo.toml",
                    "status": "completed"
                },
                {
                    "id": "goal-complete",
                    "type": "dynamicToolCall",
                    "tool": "update_goal",
                    "result": { "status": "complete" },
                    "status": "completed"
                },
                { "id": "answer-1", "type": "agentMessage", "text": "Done" }
            ]
        })]);

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "/goal Analyze the project briefly");
        assert_eq!(
            messages[0].message_type.as_deref(),
            Some(CODEX_COMMAND_MESSAGE_TYPE)
        );
        assert_eq!(messages[0].codex_turn_id.as_deref(), Some("turn-goal"));
        assert_eq!(messages[1].tool_name.as_deref(), Some("command_execution"));
        assert_eq!(messages[2].tool_name.as_deref(), Some("dynamic_tool_call"));
        assert_eq!(messages[3].role, "assistant");
        assert!(messages
            .iter()
            .all(|message| !message.content.contains("codex_internal_context")));
    }

    #[test]
    fn restores_goal_from_goal_metadata_when_turn_history_omits_user_context() {
        let mut turns = vec![json!({
            "id": "turn-goal",
            "startedAt": 1_789_222_779,
            "status": "completed",
            "items": [
                { "id": "reason-1", "type": "reasoning", "summary": [], "content": [] },
                {
                    "id": "exec-1",
                    "type": "commandExecution",
                    "aggregatedOutput": "result",
                    "status": "completed"
                },
                { "id": "answer-1", "type": "agentMessage", "text": "Done" }
            ]
        })];
        annotate_goal_turn(
            &mut turns,
            &json!({
                "goal": {
                    "objective": "分析项目，简要即可",
                    "status": "complete",
                    "createdAt": 1_789_222_779
                }
            }),
        );

        let messages = app_server_turn_messages(&turns);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].content, "/goal 分析项目，简要即可");
        assert_eq!(messages[0].codex_turn_id.as_deref(), Some("turn-goal"));
        assert_eq!(messages[1].role, "tool");
        assert_eq!(messages[2].role, "assistant");
    }

    #[test]
    fn attaches_an_edited_goal_to_the_turn_containing_updated_at() {
        let mut turns = vec![
            json!({
                "id": "turn-original-goal",
                "startedAt": 1_789_222_779_i64,
                "completedAt": 1_789_222_825_i64,
                "items": [{ "id": "old-answer", "type": "agentMessage", "text": "Old" }]
            }),
            json!({
                "id": "turn-edited-goal",
                "startedAt": 1_789_223_553_i64,
                "completedAt": 1_789_223_586_i64,
                "items": [{ "id": "new-answer", "type": "agentMessage", "text": "New" }]
            }),
        ];
        annotate_goal_turn(
            &mut turns,
            &json!({
                "goal": {
                    "objective": "你好",
                    "createdAt": 1_789_222_779_i64,
                    "updatedAt": 1_789_223_578_i64
                }
            }),
        );

        let messages = app_server_turn_messages(&turns);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].content, "Old");
        assert_eq!(messages[1].content, "/goal 你好");
        assert_eq!(
            messages[1].codex_turn_id.as_deref(),
            Some("turn-edited-goal")
        );
        assert_eq!(messages[2].content, "New");
    }

    #[test]
    fn does_not_attach_stale_goal_metadata_to_an_unrelated_turn() {
        let mut turns = vec![json!({
            "id": "turn-later",
            "startedAt": 1_789_222_900_i64,
            "items": [{ "id": "answer-1", "type": "agentMessage", "text": "Later" }]
        })];
        annotate_goal_turn(
            &mut turns,
            &json!({ "goal": { "objective": "Old goal", "createdAt": 1_789_222_779_i64 } }),
        );

        let messages = app_server_turn_messages(&turns);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Later");
    }

    #[test]
    fn does_not_synthesize_a_goal_command_when_codex_has_no_current_goal() {
        let mut turns = vec![json!({
            "id": "turn-1",
            "startedAt": 1_789_222_779_i64,
            "items": [{ "id": "answer-1", "type": "agentMessage", "text": "Done" }]
        })];
        annotate_goal_turn(&mut turns, &json!({ "goal": null }));

        let messages = app_server_turn_messages(&turns);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].content, "Done");
    }

    #[test]
    fn does_not_duplicate_goal_command_for_continuation_turns() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-goal-continuation",
            "startedAt": 1_730_910_000,
            "status": "completed",
            "items": [
                {
                    "id": "goal-context",
                    "type": "userMessage",
                    "content": "<codex_internal_context source=\"goal\">\n<objective>Ship it</objective>\n- Tokens used: 120\n</codex_internal_context>"
                },
                { "id": "answer-1", "type": "agentMessage", "text": "Continuing" }
            ]
        })]);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
    }

    #[test]
    fn does_not_restore_automatic_compaction_as_a_user_command() {
        let messages = app_server_turn_messages(&[json!({
            "id": "turn-auto-compact",
            "startedAt": 1_730_910_000,
            "status": "completed",
            "items": [
                {
                    "id": "user-1",
                    "type": "userMessage",
                    "content": "Continue"
                },
                {
                    "id": "compaction-1",
                    "type": "contextCompaction"
                },
                {
                    "id": "assistant-1",
                    "type": "agentMessage",
                    "text": "Done"
                }
            ]
        })]);

        assert_eq!(messages.len(), 3);
        assert!(messages
            .iter()
            .all(|message| message.message_type.as_deref() != Some(CODEX_COMMAND_MESSAGE_TYPE)));
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "system");
        assert_eq!(messages[2].role, "assistant");
    }

    #[test]
    fn gives_tool_lifecycle_events_the_provider_item_identity() {
        let metadata = item_metadata(&json!({
            "id": "call-1",
            "type": "commandExecution"
        }));
        assert_eq!(metadata.message_id.as_deref(), Some("call-1"));
        assert_eq!(metadata.source_message_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn projects_completed_agent_message_as_authoritative_snapshot() {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({ "id": "message-1", "type": "agentMessage", "text": "Final answer" }),
            None,
        )
        .expect("completed agent message");

        assert!(matches!(
            chunk,
            AgentChunk::Text { thread_id, text }
                if thread_id == "thread-1" && text == "Final answer"
        ));
        assert_eq!(metadata.message_id.as_deref(), Some("message-1"));
        assert_eq!(metadata.source_message_id.as_deref(), Some("message-1"));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
        assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
    }

    #[tokio::test]
    async fn preserves_distinct_identical_idless_agent_items_and_suppresses_terminal_replay() {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let first = json!({ "type": "agentMessage", "text": "Final answer" });
        let second = json!({ "type": "agentMessage", "text": "Final answer" });
        let mut first_metadata = AgentChunkMetadata::default();
        let mut second_metadata = AgentChunkMetadata::default();
        let first_should_emit = should_emit_completed_agent_message(
            &messages,
            &first,
            Some("turn-1"),
            None,
            &mut first_metadata,
        )
        .await;
        let second_should_emit = should_emit_completed_agent_message(
            &messages,
            &second,
            Some("turn-1"),
            None,
            &mut second_metadata,
        )
        .await;

        assert!(first_should_emit);
        assert_eq!(
            first_metadata.message_id.as_deref(),
            Some(codex_fallback_item_message_id("turn-1", "assistant", "Final answer", 0).as_str())
        );
        assert!(second_should_emit);
        assert_eq!(
            second_metadata.message_id.as_deref(),
            Some(codex_fallback_item_message_id("turn-1", "assistant", "Final answer", 1).as_str())
        );

        let history = app_server_turn_messages(&[json!({
            "id": "turn-1",
            "status": "completed",
            "items": [first.clone(), second.clone()]
        })]);
        assert_eq!(
            history
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            [
                first_metadata.message_id.as_deref().unwrap(),
                second_metadata.message_id.as_deref().unwrap(),
            ]
        );

        let partial_stream = Arc::new(Mutex::new(Vec::new()));
        let mut partial_metadata = AgentChunkMetadata::default();
        assert!(
            should_emit_completed_agent_message(
                &partial_stream,
                &first,
                Some("turn-1"),
                None,
                &mut partial_metadata,
            )
            .await
        );
        let mut terminal_second_metadata = AgentChunkMetadata::default();
        assert!(
            should_emit_completed_agent_message(
                &partial_stream,
                &second,
                Some("turn-1"),
                Some(1),
                &mut terminal_second_metadata,
            )
            .await
        );
        assert_eq!(
            terminal_second_metadata.message_id.as_deref(),
            Some(codex_fallback_item_message_id("turn-1", "assistant", "Final answer", 1).as_str())
        );

        let mut terminal_metadata = AgentChunkMetadata::default();
        assert!(
            !should_emit_completed_agent_message(
                &messages,
                &second,
                Some("turn-1"),
                Some(1),
                &mut terminal_metadata,
            )
            .await
        );
    }

    #[tokio::test]
    async fn uses_terminal_item_order_for_an_unseen_idless_snapshot() {
        let items = vec![
            json!({ "type": "agentMessage", "text": "Repeated", "status": "completed" }),
            json!({ "type": "agentMessage", "text": "Repeated", "status": "completed" }),
        ];
        let occurrence = codex_fallback_agent_message_occurrence(&items, 1, "completed");
        assert_eq!(occurrence, 1);

        let mut metadata = AgentChunkMetadata::default();
        let should_emit = should_emit_completed_agent_message(
            &Arc::new(Mutex::new(Vec::new())),
            &items[1],
            Some("turn-1"),
            Some(occurrence),
            &mut metadata,
        )
        .await;
        assert!(should_emit);
        assert_eq!(
            metadata.message_id.as_deref(),
            Some(codex_fallback_item_message_id("turn-1", "assistant", "Repeated", 1).as_str())
        );
    }

    #[tokio::test]
    async fn does_not_mark_an_empty_agent_snapshot_as_completed() {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let empty = json!({
            "id": "message-1",
            "type": "agentMessage",
            "text": ""
        });
        let complete = json!({
            "id": "message-1",
            "type": "agentMessage",
            "text": "Final answer"
        });

        let mut metadata = AgentChunkMetadata::default();
        assert!(
            should_emit_completed_agent_message(
                &messages,
                &empty,
                Some("turn-1"),
                None,
                &mut metadata,
            )
            .await
        );
        assert!(
            should_emit_completed_agent_message(
                &messages,
                &complete,
                Some("turn-1"),
                None,
                &mut metadata,
            )
            .await
        );
        assert!(
            !should_emit_completed_agent_message(
                &messages,
                &complete,
                Some("turn-1"),
                None,
                &mut metadata,
            )
            .await
        );
    }

    #[test]
    fn projects_completed_user_message_content_from_codex_item() {
        let item = json!({
            "id": "user-item-1",
            "type": "userMessage",
            "content": [{ "type": "text", "text": "Inspect this file" }]
        });
        let (chunk, metadata) = completed_message_chunk("thread-1", &item, Some("turn-1"))
            .expect("completed user message");

        assert!(matches!(
            chunk,
            AgentChunk::UserMessage { thread_id, id, text, .. }
                if thread_id == "thread-1" && id == "user-item-1" && text == "Inspect this file"
        ));
        assert_eq!(metadata.message_id.as_deref(), Some("user-item-1"));
        assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
        assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
    }

    #[test]
    fn suppresses_codex_native_command_echoes_but_keeps_regular_user_messages() {
        for command in ["/compact", "/GOAL", "/goal set ship it", "/goal clear"] {
            assert!(
                app_server_item_message(
                    &json!({
                        "id": "command-echo",
                        "type": "userMessage",
                        "content": command
                    }),
                    "2026-01-01T00:00:00Z",
                    0,
                    0,
                    Some("turn-1"),
                )
                .is_none(),
                "expected native command echo to be hidden: {command}"
            );
        }

        let message = app_server_item_message(
            &json!({
                "id": "regular-user",
                "type": "userMessage",
                "content": [{ "type": "text", "text": "/goal-oriented review" }]
            }),
            "2026-01-01T00:00:00Z",
            0,
            0,
            Some("turn-1"),
        )
        .expect("regular user message");
        assert_eq!(message.role, "user");
        assert_eq!(message.content, "/goal-oriented review");
    }

    #[test]
    fn recognizes_only_the_native_compact_command() {
        assert!(is_codex_compact_command(" /COMPACT "));
        assert!(!is_codex_compact_command("/compact now"));
        assert!(!is_codex_compact_command("/compactly"));
    }

    #[test]
    fn recognizes_goal_mutations_that_start_autonomous_work() {
        for command in [
            "/goal set ship it",
            "/goal edit ship it",
            "/goal pause",
            "/goal resume",
            "/GOAL SET ship it",
        ] {
            assert!(
                is_codex_goal_mutation_command(command),
                "expected goal mutation to await provider turn: {command}"
            );
        }
        for command in ["/goal", "/goal get", "/goal clear", "/goal-oriented review"] {
            assert!(
                !is_codex_goal_mutation_command(command),
                "expected synchronous/non-native goal command: {command}"
            );
        }
    }

    #[test]
    fn formats_native_goal_operation_results_without_exposing_raw_json() {
        assert_eq!(
            codex_command_result_text(
                "/goal",
                &json!({
                    "goal": {
                        "objective": "Ship the command lifecycle",
                        "status": "active"
                    }
                }),
            )
            .as_deref(),
            Some("Ship the command lifecycle (active)")
        );
        assert_eq!(
            codex_command_result_text("/goal clear", &json!({ "cleared": true })).as_deref(),
            Some("No Codex goal is currently set")
        );
    }

    #[test]
    fn projects_completed_context_compaction_with_stable_identity() {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({ "id": "compaction-1", "type": "contextCompaction" }),
            Some("turn-1"),
        )
        .expect("completed context compaction");

        assert!(matches!(
            chunk,
            AgentChunk::ContextCompaction { thread_id, id }
                if thread_id == "thread-1" && id == "compaction-1"
        ));
        assert_eq!(metadata.message_id.as_deref(), Some("compaction-1"));
        assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
    }

    #[test]
    fn context_compaction_without_provider_ids_uses_shared_fallback_identity() {
        for turn_id in [None, Some("")] {
            let (chunk, metadata) = completed_message_chunk(
                "thread-1",
                &json!({ "type": "contextCompaction" }),
                turn_id,
            )
            .expect("completed context compaction");

            assert!(matches!(
                chunk,
                AgentChunk::ContextCompaction { id, .. }
                    if id == "codex-context-compaction"
            ));
            assert!(metadata.message_id.is_none());
        }
    }

    #[test]
    fn projects_completed_reasoning_summary_as_authoritative_snapshot() {
        let (chunk, metadata) = completed_message_chunk(
            "thread-1",
            &json!({
                "id": "reasoning-1",
                "type": "reasoning",
                "summary": [{ "type": "text", "text": "Final reasoning" }],
                "content": [{ "type": "text", "text": "Hidden detail" }]
            }),
            None,
        )
        .expect("completed reasoning");

        assert!(matches!(
            chunk,
            AgentChunk::Reasoning { thread_id, text }
                if thread_id == "thread-1" && text == "Final reasoning"
        ));
        assert_eq!(metadata.message_phase.as_deref(), Some("completed"));
        assert_eq!(metadata.content_mode.as_deref(), Some("snapshot"));
    }

    #[test]
    fn turn_scoped_notifications_require_turn_id() {
        assert!(turn_scoped_notification("item/started"));
        assert!(turn_scoped_notification("item/completed"));
        assert!(turn_scoped_notification("turn/completed"));
        assert!(!turn_scoped_notification("thread/status/changed"));
    }

    #[test]
    fn client_messages_omit_the_optional_jsonrpc_header() {
        let message = json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "flowix", "version": "1" } }
        });
        assert!(message.get("jsonrpc").is_none());
    }

    #[test]
    fn projects_app_server_history_without_persisting_it() {
        let thread = json!({
            "turns": [{
                "id": "turn-1",
                "startedAt": 1_730_910_000,
                "durationMs": 69078,
                "items": [
                    { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] },
                    { "id": "a1", "type": "agentMessage", "text": "Hi" },
                    { "id": "r1", "type": "reasoning", "summary": ["Plan"] },
                    { "id": "c1", "type": "commandExecution", "command": "git status", "status": "completed", "aggregatedOutput": "clean" }
                ]
            }]
        });

        let messages = app_server_turn_messages(
            thread
                .get("turns")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "Hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].turn_duration_ms, Some(69078));
        assert_eq!(messages[2].reasoning.as_deref(), Some("Plan"));
        assert_eq!(messages[3].tool_name.as_deref(), Some("command_execution"));
        assert_eq!(
            messages[3]
                .tool_input
                .as_ref()
                .and_then(|input| input.get("command")),
            Some(&json!("git status")),
        );
        assert!(messages[3].tool_data.is_some());
    }

    #[test]
    fn preserves_interleaved_app_server_item_order() {
        let thread = json!({
            "turns": [{
                "startedAt": 1_730_910_000,
                "items": [
                    { "id": "a1", "type": "agentMessage", "text": "I will inspect this." },
                    { "id": "c1", "type": "commandExecution", "command": "pwd", "status": "completed" },
                    { "id": "a2", "type": "agentMessage", "text": "The result is ..." }
                ]
            }]
        });

        let messages = app_server_turn_messages(
            thread
                .get("turns")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );

        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["assistant", "tool", "assistant"],
        );
        assert_eq!(messages[1].id, "c1");
    }

    #[test]
    fn projects_failed_turn_errors_from_app_server_history() {
        let turns = vec![json!({
            "id": "turn-1",
            "startedAt": 1_730_910_000,
            "status": "failed",
            "error": { "message": "rate limit exceeded" },
            "items": [{ "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] }]
        })];

        let messages = app_server_turn_messages(&turns);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "rate limit exceeded");
        assert_eq!(messages[1].id, codex_turn_error_message_id("turn-1"));
        assert!(messages[1].error_details.is_some());
    }

    #[test]
    fn live_turn_error_metadata_uses_the_history_identity() {
        let metadata = codex_turn_error_metadata(Some("turn-1"));
        let expected_id = codex_turn_error_message_id("turn-1");

        assert_eq!(metadata.codex_turn_id.as_deref(), Some("turn-1"));
        assert_eq!(metadata.message_id.as_deref(), Some(expected_id.as_str()));
    }

    #[test]
    fn keeps_tool_items_and_interruption_with_their_own_turn() {
        let turns = vec![
            json!({
                "id": "turn-1",
                "startedAt": 1_730_910_000,
                "status": "interrupted",
                "items": [
                    { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Inspect it" }] },
                    { "id": "a1", "type": "agentMessage", "text": "Checking." },
                    { "id": "tool-1", "type": "commandExecution", "command": "pwd", "status": "completed", "aggregatedOutput": "/workspace" }
                ]
            }),
            json!({
                "id": "turn-2",
                "startedAt": 1_730_911_000,
                "status": "completed",
                "items": [
                    { "id": "u2", "type": "userMessage", "content": [{ "type": "text", "text": "Next" }] },
                    { "id": "a2", "type": "agentMessage", "text": "Done." }
                ]
            }),
        ];

        let messages = app_server_turn_messages(&turns);
        assert_eq!(
            messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            [
                "u1",
                "a1",
                "tool-1",
                "msg:codex:turn-error:turn-1",
                "u2",
                "a2"
            ],
        );
        assert_eq!(messages[2].role, "tool");
        assert_eq!(messages[3].content, "Codex turn interrupted");
    }

    #[test]
    fn omits_unfinished_assistant_items_from_interrupted_turn_history() {
        let turns = vec![json!({
            "id": "turn-interrupted",
            "startedAt": 1_730_910_000,
            "status": "interrupted",
            "items": [
                { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Inspect" }] },
                { "id": "draft", "type": "agentMessage", "status": "inProgress", "text": "unfinished" },
                { "id": "answer", "type": "agentMessage", "status": "completed", "text": "Completed before stop" }
            ]
        })];

        let messages = app_server_turn_messages(&turns);
        assert_eq!(
            messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["u1", "answer", "msg:codex:turn-error:turn-interrupted"],
        );
        assert_eq!(messages[1].content, "Completed before stop");
        assert_eq!(messages[1].is_completed, Some(true));
    }

    #[test]
    fn history_fallback_ids_ignore_omitted_interrupted_items() {
        let items = vec![
            json!({ "type": "agentMessage", "status": "inProgress", "text": "Repeated" }),
            json!({ "type": "agentMessage", "status": "completed", "text": "Repeated" }),
        ];
        let turn_id = "turn-interrupted";
        let occurrence = codex_fallback_agent_message_occurrence(&items, 1, "interrupted");
        let history = app_server_turn_messages(&[json!({
            "id": turn_id,
            "status": "interrupted",
            "items": items
        })]);
        let assistant = history
            .iter()
            .find(|message| message.role == "assistant")
            .expect("completed assistant message");

        assert_eq!(occurrence, 0);
        assert_eq!(
            assistant.id,
            codex_fallback_item_message_id(turn_id, "assistant", "Repeated", occurrence)
        );
    }

    #[test]
    fn pages_projected_history_on_complete_turn_boundaries() {
        let turns = (0..3)
            .map(|index| json!({
                "id": format!("turn-{index}"),
                "startedAt": 1_730_911_000 + index,
                "status": "completed",
                "items": [
                    { "id": format!("u{index}"), "type": "userMessage", "content": format!("Q{index}") },
                    { "id": format!("a{index}"), "type": "agentMessage", "text": format!("A{index}") }
                ]
            }))
            .collect::<Vec<_>>();
        let page = paginate_app_server_turns(&turns, None, None, 2);
        assert_eq!(page.messages.len(), 4);
        assert_eq!(page.messages[0].id, "u1");
        assert_eq!(page.oldest_sequence, Some(1));
        assert_eq!(page.snapshot_sequence, Some(3));
        assert!(page.has_more);

        let older = paginate_app_server_turns(
            &[
                turns,
                vec![json!({
                    "id": "turn-3",
                    "startedAt": 1_730_911_003,
                    "status": "completed",
                    "items": [{ "id": "u3", "type": "userMessage", "content": "new" }]
                })],
            ]
            .concat(),
            page.oldest_sequence,
            page.snapshot_sequence,
            2,
        );
        assert_eq!(
            older
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["u0", "a0"]
        );
        assert_eq!(older.snapshot_sequence, Some(3));
    }

    #[test]
    fn ordinary_chat_waits_for_its_start_response_before_routing_events() {
        assert_eq!(
            unbound_notification_action(TurnBinding::StartResponse, "turn/started", true),
            UnboundNotificationAction::Buffer
        );
        assert_eq!(
            unbound_notification_action(
                TurnBinding::StartResponse,
                "item/agentMessage/delta",
                true,
            ),
            UnboundNotificationAction::Buffer
        );
        assert_eq!(
            unbound_notification_action(
                TurnBinding::StartResponse,
                "thread/tokenUsage/updated",
                true,
            ),
            UnboundNotificationAction::Ignore
        );
    }

    #[test]
    fn asynchronous_commands_bind_only_from_turn_started() {
        assert_eq!(
            unbound_notification_action(TurnBinding::StartedNotification, "turn/started", true,),
            UnboundNotificationAction::Bind
        );
        assert_eq!(
            unbound_notification_action(TurnBinding::StartedNotification, "item/completed", true,),
            UnboundNotificationAction::Buffer
        );
        assert_eq!(
            unbound_notification_action(TurnBinding::StartedNotification, "turn/started", false,),
            UnboundNotificationAction::Ignore
        );
    }
}
