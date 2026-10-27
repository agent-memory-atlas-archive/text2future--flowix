import type { AppLanguage, I18nKey, I18nParams } from "@/lib/i18n";
import type { AgentTypeKey } from "@/types/agent";
import skillLibraryIconSvg from "@/assets/skill-library.svg?raw";
import { agent, windows } from "@platform/tauri/client";
import { openWorkspaceSurface } from "@features/workspace/public/open-surface-api";
import { NOTEBOOK_SKILLS_CHANGED_EVENT } from "@features/agent/services/notebook-skills-events";
import type { ComposerSlashSkill } from "../composer/composer-slash-command-controller";
import { preferredComposerSkillName } from "../composer/composer-skill-token";
import { createChevronIcon } from "../agent-thread-card-icons";
import { disposeEmptyState, registerEmptyStateLifecycle } from "../messages/empty-state-lifecycle";
import { createExternalAgentEmptyIcon } from "./external-agent-settings";
import { FeaturedNotesController, type FeaturedNoteReference } from "./featured-notes-controller";

export type AgentEmptyStatePresentation = "inline-card" | "expanded";

interface AgentEmptyStateOptions {
  getTypeKey: () => AgentTypeKey;
  getInstanceId: () => string | undefined;
  getLanguage: () => AppLanguage;
  getNotebookId: () => string | null;
  getNotebookPath: () => string | null;
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  onSelectFeaturedNote?: (ref: FeaturedNoteReference) => void;
  onSelectEmptyPrompt?: (prompt: string) => void;
  onSelectEmptySkill?: (skill: ComposerSlashSkill) => void;
  onOpenEmptySkills?: () => void;
  appendRuntimeSettings: (root: HTMLElement, presentation: AgentEmptyStatePresentation) => void;
  refreshRuntimeSettings: () => void;
  clearRuntimeSettings: (root: HTMLElement) => void;
}

const EMPTY_STATE_SKILL_AGENT_TYPES = new Set<AgentTypeKey>(["codex", "dsh", "pi"]);
const EMPTY_STATE_SKILL_LIMIT = 6;
const EMPTY_STATE_PROMPTS = [
  { label: "agent.empty.prompt.introduction", prompt: "agent.empty.prompt.introduction.text" },
  { label: "agent.empty.prompt.createNote", prompt: "agent.empty.prompt.createNote.text" },
  { label: "agent.empty.prompt.summary", prompt: "agent.empty.prompt.summary.text" },
] as const satisfies readonly { label: I18nKey; prompt: I18nKey }[];

function createEmptySkillIcon(): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = skillLibraryIconSvg;
  const icon = template.content.firstElementChild;
  if (!(icon instanceof SVGSVGElement)) {
    throw new Error("Failed to render skill library icon");
  }
  icon.classList.add("agent-thread-card__empty-skill-icon");
  return icon;
}

/** Owns the empty root, guidance, skills and the featured panel's detached resources.
 * Runtime settings remain with their controller and participate through explicit callbacks.
 */
export class AgentEmptyStateController {
  private root: HTMLElement | null = null;
  private disposed = false;
  private emptySkillRequestId = 0;
  private emptySkillsSurface: { container: HTMLElement; list: HTMLElement } | null = null;
  private readonly featuredNotes: FeaturedNotesController;

  constructor(private readonly options: AgentEmptyStateOptions) {
    this.featuredNotes = new FeaturedNotesController({
      getNotebookId: options.getNotebookId,
      t: options.t,
      isDestroyed: () => this.isDestroyed(),
      onSelectFeaturedNote: options.onSelectFeaturedNote,
    });
  }

  private getTypeKey = () => this.options.getTypeKey();
  private getCurrentNotebookPath = () => this.options.getNotebookPath();
  private t = (key: I18nKey, params?: I18nParams) => this.options.t(key, params);
  private isDestroyed = () => this.disposed || this.options.isDestroyed();

  private readonly handleNotebookSkillsChanged = (event: Event): void => {
    const detail = (event as CustomEvent<{ notebookId?: unknown }>).detail;
    if (detail?.notebookId !== this.options.getNotebookId()) return;
    const current = this.emptySkillsSurface;
    if (current?.container.isConnected && current.list.isConnected) {
      void this.loadEmptySkills(current.container, current.list);
    }
  };

  create(presentation: AgentEmptyStatePresentation): HTMLElement {
    if (this.disposed) throw new Error("Cannot create an empty state after disposal");
    if (this.root) disposeEmptyState(this.root);
    const root = document.createElement("div");
    root.className = [
      "agent-thread-card__empty",
      "agent-thread-card__empty--codex-settings",
      `agent-thread-card__empty--${presentation}`,
    ].join(" ");
    this.root = root;
    const contextKey = this.getContextKey();
    registerEmptyStateLifecycle(root, {
      canReuse: () => !this.isDestroyed() && this.root === root && contextKey === this.getContextKey(),
      refresh: this.options.refreshRuntimeSettings,
      dispose: () => this.release(root),
    });
    if (presentation === "expanded") {
      this.appendExpandedEmptyGuidance(root);
      window.addEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, this.handleNotebookSkillsChanged);
    } else {
      root.append(createExternalAgentEmptyIcon(this.getTypeKey()));
    }
    this.options.appendRuntimeSettings(root, presentation);
    if (presentation === "expanded") void this.featuredNotes.appendFeaturedNotes(root);
    return root;
  }

  private getContextKey(): string {
    return JSON.stringify([
      this.options.getInstanceId(), this.getTypeKey(), this.options.getLanguage(),
      this.options.getNotebookId(), this.getCurrentNotebookPath(),
    ]);
  }

  private release(root: HTMLElement): void {
    if (this.root !== root) return;
    this.root = null;
    this.emptySkillRequestId += 1;
    this.emptySkillsSurface = null;
    window.removeEventListener(NOTEBOOK_SKILLS_CHANGED_EVENT, this.handleNotebookSkillsChanged);
    this.featuredNotes.clear();
    this.options.clearRuntimeSettings(root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root) disposeEmptyState(this.root);
    this.featuredNotes.dispose();
  }

  private appendExpandedEmptyGuidance(empty: HTMLElement): void {
    const welcomeCard = document.createElement("div");
    welcomeCard.className = "agent-thread-card__empty-welcome";
    welcomeCard.append(createExternalAgentEmptyIcon(this.getTypeKey()));

    const actions = document.createElement("div");
    actions.className = "agent-thread-card__empty-welcome-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "agent-thread-card__empty-welcome-action";
    editButton.textContent = this.t("preferences.documentProperties.edit");
    editButton.disabled = true;
    const modelButton = document.createElement("button");
    modelButton.type = "button";
    modelButton.className = "agent-thread-card__empty-welcome-action";
    modelButton.textContent = this.t("agent.model.title");
    modelButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const typeKey = this.getTypeKey();
      const preferencesTab = typeKey === "pi" ? "pi" : typeKey === "dsh" ? "dsh" : "aiAgent";
      void windows.openPreferences(preferencesTab);
    });
    const skillMarketButton = document.createElement("button");
    skillMarketButton.type = "button";
    skillMarketButton.className = "agent-thread-card__empty-welcome-action";
    skillMarketButton.textContent = this.t("agent.empty.skillMarket");
    skillMarketButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void openWorkspaceSurface({
        host: "browser-column",
        target: { kind: "web", url: "https://skills.flowix.cc/i/index" },
      });
    });
    for (const button of [editButton, modelButton, skillMarketButton]) {
      button.addEventListener("mousedown", (event) => event.stopPropagation());
    }
    actions.append(editButton, modelButton, skillMarketButton);

    const start = document.createElement("p");
    start.className = "agent-thread-card__empty-start";
    start.textContent = this.t("agent.empty.startPrompt");

    const promptList = document.createElement("div");
    promptList.className = "agent-thread-card__empty-prompts";
    promptList.setAttribute("role", "group");
    promptList.setAttribute("aria-label", this.t("agent.empty.promptGroup"));
    for (const item of EMPTY_STATE_PROMPTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-thread-card__empty-prompt";
      button.textContent = this.t(item.label);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onSelectEmptyPrompt?.(this.t(item.prompt));
      });
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      promptList.append(button);
    }
    welcomeCard.append(actions, start, promptList);
    empty.append(welcomeCard);

    if (!EMPTY_STATE_SKILL_AGENT_TYPES.has(this.getTypeKey())) return;
    const skills = document.createElement("section");
    skills.className = "agent-thread-card__empty-skills";
    skills.setAttribute("aria-label", this.t("agent.empty.skills"));
    const heading = document.createElement("h3");
    heading.className = "agent-thread-card__empty-section-title";
    heading.textContent = this.t("agent.empty.skills");
    const list = document.createElement("div");
    list.className = "agent-thread-card__empty-skill-list";
    list.setAttribute("aria-live", "polite");
    list.setAttribute("aria-busy", "true");
    list.textContent = this.t("agent.empty.skills.loading");
    this.emptySkillsSurface = { container: empty, list };
    skills.append(heading, list);
    empty.append(skills);
    void this.loadEmptySkills(empty, list);
  }

  private async loadEmptySkills(empty: HTMLElement, list: HTMLElement): Promise<void> {
    const requestId = ++this.emptySkillRequestId;
    const typeKey = this.getTypeKey();
    const notebookPath = this.getCurrentNotebookPath();
    const isCurrentRequest = (): boolean => (
      !this.isDestroyed()
      && requestId === this.emptySkillRequestId
      && this.getTypeKey() === typeKey
      && this.getCurrentNotebookPath() === notebookPath
      && empty.isConnected
    );
    try {
      const skills = notebookPath
        ? await agent.readNotebookAgentSkills(notebookPath)
        : await Promise.resolve([]);
      if (!isCurrentRequest()) return;
      const suggestions = skills
        .filter((skill) => skill.enabled && skill.id.trim())
        .map((skill): ComposerSlashSkill => ({
          name: typeKey === "pi" ? skill.commandName?.trim() || skill.id : skill.id,
          displayName: skill.name.trim() || skill.id,
          description: skill.description,
          scope: "workspace",
        }))
        .filter((skill) => skill.name.trim());
      const hasMoreSkills = suggestions.length > EMPTY_STATE_SKILL_LIMIT;
      const visibleSkillLimit = hasMoreSkills
        ? EMPTY_STATE_SKILL_LIMIT - 1
        : EMPTY_STATE_SKILL_LIMIT;
      this.renderEmptySkills(
        list,
        suggestions.slice(0, visibleSkillLimit),
        hasMoreSkills,
      );
    } catch {
      if (!isCurrentRequest()) return;
      this.renderEmptySkills(list, []);
    }
  }

  private renderEmptySkills(
    list: HTMLElement,
    skills: readonly ComposerSlashSkill[],
    hasMoreSkills = false,
  ): void {
    list.removeAttribute("aria-busy");
    list.replaceChildren();
    if (!skills.length) {
      list.classList.add("agent-thread-card__empty-skill-list--empty");
      const empty = document.createElement("span");
      empty.className = "agent-thread-card__empty-skill-hint";
      empty.textContent = this.t("agent.empty.skills.none");
      const skillMarketButton = document.createElement("button");
      skillMarketButton.type = "button";
      skillMarketButton.className = "agent-thread-card__empty-welcome-action agent-thread-card__empty-skill-market";
      skillMarketButton.textContent = this.t("agent.empty.skillMarket");
      skillMarketButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void openWorkspaceSurface({
          host: "browser-column",
          target: { kind: "web", url: "https://skills.flowix.cc/i/index" },
        });
      });
      skillMarketButton.addEventListener("mousedown", (event) => event.stopPropagation());
      list.append(empty, skillMarketButton);
      return;
    }
    list.classList.remove("agent-thread-card__empty-skill-list--empty");
    for (const skill of skills) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-thread-card__empty-skill";
      const titleText = preferredComposerSkillName(skill.name, skill.displayName);
      const descriptionText = skill.description.trim()
        || skill.shortDescription?.trim()
        || skill.name;
      button.title = descriptionText;
      button.setAttribute(
        "aria-label",
        this.t("agent.empty.skills.use", { name: titleText }),
      );
      const title = document.createElement("span");
      title.className = "agent-thread-card__empty-skill-title";
      title.textContent = titleText;
      const description = document.createElement("span");
      description.className = "agent-thread-card__empty-skill-description";
      description.textContent = descriptionText;
      const content = document.createElement("span");
      content.className = "agent-thread-card__empty-skill-content";
      content.append(title, description);
      button.append(createEmptySkillIcon(), content);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.onSelectEmptySkill?.(skill);
      });
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      list.append(button);
    }
    if (!hasMoreSkills) return;
    const moreButton = document.createElement("button");
    moreButton.type = "button";
    moreButton.className = "agent-thread-card__empty-skill agent-thread-card__empty-skill--more";
    moreButton.setAttribute("aria-label", this.t("agent.empty.skills.more"));
    moreButton.setAttribute("aria-haspopup", "listbox");
    const moreTitle = document.createElement("span");
    moreTitle.className = "agent-thread-card__empty-skill-title";
    moreTitle.textContent = this.t("agent.empty.skills.more");
    moreTitle.append(createChevronIcon("down"));
    moreButton.append(moreTitle);
    moreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onOpenEmptySkills?.();
    });
    moreButton.addEventListener("mousedown", (event) => event.stopPropagation());
    list.append(moreButton);
  }

}
