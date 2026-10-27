/** Only a missing installation IPC command means this client needs an upgrade. */
export function isSkillInstallationUnavailable(message: string): boolean {
  return /^(?:unknown command\s+['"`]?codex_project_skill_install_zip['"`]?|command\s+['"`]?codex_project_skill_install_zip['"`]?\s+(?:not found|(?:is\s+)?not implemented))[.!]?$/i.test(message.trim());
}
