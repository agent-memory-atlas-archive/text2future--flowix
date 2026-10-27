/**
 * Notebook skill invalidation. Consumers that render skill-backed surfaces need
 * both the event name (to listen) and the notifier (to invalidate after install).
 */
export {
  NOTEBOOK_SKILLS_CHANGED_EVENT,
  notifyNotebookSkillsChanged,
} from '../services/notebook-skills-events';
export type { NotebookSkillsChangedDetail } from '../services/notebook-skills-events';
