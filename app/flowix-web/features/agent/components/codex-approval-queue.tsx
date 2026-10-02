'use client';

import { useEffect, useRef, useState } from 'react';
import {
  agent,
  listenToCodexApprovalRequests,
  type CodexApprovalRequest,
} from '@platform/tauri/client';

export function CodexApprovalQueue({ threadId }: { threadId: string | null }) {
  const [approvals, setApprovals] = useState<CodexApprovalRequest[]>([]);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const resolvedApprovalIds = useRef(new Set<string>());
  const approval = approvals[0] ?? null;

  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    setApprovals([]);
    setApprovalError(null);
    resolvedApprovalIds.current.clear();
    const addRequest = (request: CodexApprovalRequest) => {
      if (request.flowixThreadId !== threadId || resolvedApprovalIds.current.has(request.requestId)) return;
      setApprovals((current) => current.some((item) => item.requestId === request.requestId)
        ? current
        : [...current, request]);
    };
    const unlisten = listenToCodexApprovalRequests(addRequest);
    void agent.codexApprovalPending().then((pending) => {
      if (!disposed) pending.forEach(addRequest);
    }).catch((error) => {
      console.warn('[CodexApprovalQueue] Failed to load pending approvals:', error);
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [threadId]);

  const respondToApproval = async (decision: 'accept' | 'decline') => {
    if (!approval || responding) return;
    const request = approval;
    setResponding(true);
    setApprovalError(null);
    try {
      await agent.codexApprovalRespond(request.requestId, approvalResult(request, decision));
      resolvedApprovalIds.current.add(request.requestId);
      setApprovals((current) => current.filter((item) => item.requestId !== request.requestId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('no longer pending')) {
        resolvedApprovalIds.current.add(request.requestId);
        setApprovals((current) => current.filter((item) => item.requestId !== request.requestId));
      } else {
        setApprovalError(message);
      }
      console.warn('[CodexApprovalQueue] Approval response failed:', error);
    } finally {
      setResponding(false);
    }
  };

  if (!approval) return null;

  return (
    <div className="agent-background-terminals agent-background-terminals--approval" role="status" aria-live="assertive">
      <div className="agent-background-terminals__approval">
        <span className="agent-background-terminals__approval-dot" aria-hidden="true" />
        <div className="agent-background-terminals__approval-copy">
          <strong>Codex 请求确认</strong>
          <span>
            {approval.method === 'item/fileChange/requestApproval'
              ? 'Codex 请求应用文件变更。'
              : 'Codex 请求执行需要确认的操作。'}
          </span>
          <code>{formatApprovalParams(approval.params)}</code>
          {approvalError && <span className="agent-background-terminals__approval-error">确认失败：{approvalError}</span>}
        </div>
        <div className="agent-background-terminals__approval-actions">
          <button type="button" disabled={responding} onClick={() => void respondToApproval('decline')}>取消</button>
          <button type="button" disabled={responding} onClick={() => void respondToApproval('accept')}>确认执行</button>
        </div>
      </div>
    </div>
  );
}

function formatApprovalParams(params: Record<string, unknown>): string {
  const command = params.command;
  const cwd = params.cwd;
  if (Array.isArray(command) || typeof command === 'string') {
    return [Array.isArray(command) ? command.join(' ') : command, cwd ? `cwd: ${String(cwd)}` : '']
      .filter(Boolean)
      .join(' · ');
  }
  return JSON.stringify(params, null, 2);
}

function approvalResult(
  request: CodexApprovalRequest,
  decision: 'accept' | 'decline',
): Record<string, unknown> {
  if (request.method === 'item/permissions/requestApproval') {
    return {
      permissions: decision === 'accept' ? request.params.permissions ?? {} : {},
      scope: 'turn',
      strictAutoReview: null,
    };
  }
  return { decision: decision === 'accept' ? 'accept' : 'decline' };
}
