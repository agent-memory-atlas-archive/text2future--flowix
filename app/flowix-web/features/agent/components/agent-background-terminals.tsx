'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowBendDownRightIcon } from '@phosphor-icons/react';
import { useI18n } from '@/lib/i18n';
import { agentClient } from '@features/agent/store/agent-client';

interface BackgroundTerminal {
  id: string;
  command: string;
  cwd?: string;
  status?: string;
}

function readTerminals(value: unknown): BackgroundTerminal[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const raw = Array.isArray(value) ? value : root.data ?? root.jobs ?? root.terminals ?? root.backgroundTerminals;
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      id: String(row.id ?? row.terminalId ?? index),
      command: String(row.command ?? row.cmd ?? row.process ?? row.label ?? '后台进程'),
      cwd: typeof row.cwd === 'string' ? row.cwd : undefined,
      status: typeof row.status === 'string' ? row.status : undefined,
    };
  });
}

export function AgentBackgroundTerminals({ threadId, agentType, enabled, queuedMessages = [] }: { threadId: string | null; agentType: 'codex' | 'deepseek-harness'; enabled: boolean; queuedMessages?: string[] }) {
  const { t } = useI18n();
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (running) return;
      if (!threadId || !enabled) {
        setTerminals([]);
        return;
      }
      running = true;
      try {
        const result = agentType === 'codex'
          ? await agentClient.backgroundTerminals(threadId)
          : await agentClient.backgroundJobs(threadId);
        if (!disposed) {
          setTerminals(readTerminals(result));
          setFailed(false);
        }
      } catch {
        // An older Codex app-server may not implement this experimental API.
        if (!disposed) setFailed(true);
      } finally {
        running = false;
        // Schedule from completion so slow IPC calls never overlap. Hidden
        // windows resume through visibilitychange instead of polling.
        if (!disposed && document.visibilityState === 'visible') {
          timer = window.setTimeout(() => {
            timer = undefined;
            void refresh();
          }, 2000);
        }
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (timer === undefined && !running) void refresh();
    };
    if (document.visibilityState === 'visible') void refresh();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [agentType, enabled, threadId]);

  const countLabel = useMemo(() => t('agent.backgroundTerminals.count', { count: terminals.length }), [t, terminals.length]);
  if (!enabled || ((failed || terminals.length === 0) && queuedMessages.length === 0)) return null;

  return (
    <div className="agent-background-terminals" data-expanded={expanded}>
      {!failed && terminals.length > 0 && <button
        type="button"
        className="agent-background-terminals__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="agent-background-terminals__dot" aria-hidden="true" />
        <span className="agent-background-terminals__label">{countLabel}</span>
        <span className="agent-background-terminals__command">{terminals[0].command}</span>
        <svg className="agent-background-terminals__chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
        </svg>
      </button>}
      {!failed && expanded && terminals.length > 0 && (
        <div className="agent-background-terminals__details">
          {terminals.map((terminal) => (
            <div className="agent-background-terminals__row" key={terminal.id}>
              <span className="agent-background-terminals__status" />
              <code>{terminal.command}</code>
              {terminal.cwd && <span className="agent-background-terminals__cwd">{terminal.cwd}</span>}
              {terminal.status && <span className="agent-background-terminals__state">{terminal.status}</span>}
            </div>
          ))}
        </div>
      )}
      {queuedMessages.length > 0 && <QueuedMessages messages={queuedMessages} label={t('agent.backgroundTerminals.queued')} />}
    </div>
  );
}

function QueuedMessages({ messages, label }: { messages: string[]; label: string }) {
  return (
    <div className="agent-background-terminals__queue" aria-label={label}>
      {messages.map((message, index) => (
        <div className="agent-background-terminals__queue-row" key={`${index}-${message}`}>
          <span className="agent-background-terminals__queue-mark">
            <ArrowBendDownRightIcon aria-hidden="true" />
          </span>
          <span>{message}</span>
        </div>
      ))}
    </div>
  );
}
