/** True when a provider explicitly reports that the requested session is gone. */
export function isMissingAgentSessionError(error: unknown): boolean {
  if (!error) return false;

  const value = error as {
    code?: unknown;
    message?: unknown;
    data?: { code?: unknown };
  };
  if (
    value.code === "session_not_found" ||
    value.data?.code === "session_not_found" ||
    value.code === -32020
  ) {
    return true;
  }

  const message = error instanceof Error
    ? error.message
    : typeof value.message === "string"
      ? value.message
      : String(error);
  return /\bsession[_\s]+not[_\s]+found\b/i.test(message) ||
    /\bsession\s+["'][^"']+["']\s+not found\b/i.test(message) ||
    /\bsession\s+not found:\s*["']?[\w.-]+["']?/i.test(message);
}
