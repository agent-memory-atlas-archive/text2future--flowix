import { describe, expect, it } from 'vitest';
import { isSkillInstallationUnavailable } from './skill-market-install-error';

describe('skill installation availability errors', () => {
  it.each([
    'Command codex_project_skill_install_zip not found',
    "Unknown command 'codex_project_skill_install_zip'",
    'Command `codex_project_skill_install_zip` is not implemented.',
  ])('recognizes the missing installation command: %s', (message) => {
    expect(isSkillInstallationUnavailable(message)).toBe(true);
  });

  it.each([
    'Skill package contains an unsupported file encoding',
    'unsupported compression method',
    'Operation not implemented by the filesystem',
    'Command another_command not found',
    'Permission denied',
    'Network request failed',
  ])('does not turn an installation failure into an upgrade prompt: %s', (message) => {
    expect(isSkillInstallationUnavailable(message)).toBe(false);
  });
});
