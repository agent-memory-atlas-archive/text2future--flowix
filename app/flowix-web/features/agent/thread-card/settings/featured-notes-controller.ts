import type { I18nKey, I18nParams } from '@/lib/i18n';
import { memos as memosClient } from '@platform/tauri/client';
import { openNoteByNotebookPath } from '@features/memo/use-cases/open-by-target';
import { applyPopoverPosition, calculateAnchoredPopoverPosition } from '../popover/popover-position';
import { createCheckIcon, createChevronIcon, createPlusIcon, createTrashIcon } from '../agent-thread-card-icons';
import {
  FEATURED_NOTE_MOBILE_PAGE_SIZE,
  FEATURED_NOTE_PAGE_SIZE,
  MAX_FEATURED_NOTE_CONDITIONS,
  appendFeaturedNoteIconContent,
  getFeaturedNotePage,
  getFeaturedNotePageCountForSize,
  getFeaturedPathNoteCards,
  normalizeFeaturedNoteFilterConfig,
  readFeaturedNoteFilter,
  writeFeaturedNoteFilter,
  type FeaturedNoteCard,
  type FeaturedNoteFilter,
  type FeaturedNoteFilterConfig,
  type FeaturedNoteFilterOperator,
} from "@features/agent/thread-card/settings/featured-note-cards";

const FEATURED_NOTES_MOBILE_QUERY = "(max-width: 767px)";
/** 精选笔记设置弹层与 composer 弹窗一致: fixed 定位、视口坐标、贴边留白。 */
const FEATURED_NOTES_SETTINGS_POPOVER_WIDTH_PX = 420;
const FEATURED_NOTES_SETTINGS_POPOVER_OFFSET_PX = 6;
const FEATURED_NOTES_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;

interface FeaturedNotesOptions {
  getNotebookId: () => string | null;
  t: (key: I18nKey, params?: I18nParams) => string;
  isDestroyed: () => boolean;
  onSelectFeaturedNote?: (ref: { id: string; filename: string; title: string; notebookId?: string; relativePath?: string }) => void;
}

/** Owns note queries, filtering UI and its detached popover lifecycle. */
export class FeaturedNotesController {
  private featuredNotesRequestId = 0;
  private featuredNotesViewportCleanup: (() => void) | null = null;
  private disposed = false;
  constructor(private readonly options: FeaturedNotesOptions) {}
  private getCurrentNotebookId = () => this.options.getNotebookId();
  private t = (key: I18nKey, params?: I18nParams) => this.options.t(key, params);
  private isDestroyed = () => this.disposed || this.options.isDestroyed();
  private get onSelectFeaturedNote() { return this.options.onSelectFeaturedNote; }
  dispose(): void {
    this.disposed = true;
    this.featuredNotesRequestId += 1;
    this.featuredNotesViewportCleanup?.();
  }

  async appendFeaturedNotes(empty: HTMLElement): Promise<void> {
    const notebookId = this.getCurrentNotebookId();
    if (!notebookId) return;

    this.featuredNotesViewportCleanup?.();
    empty.querySelector(".agent-thread-card__featured-notes")?.remove();
    const requestId = ++this.featuredNotesRequestId;
    const config = await readFeaturedNoteFilter(notebookId);
    if (this.isDestroyed() || requestId !== this.featuredNotesRequestId) return;
    try {
      const indexed = await memosClient.listNotesByPath(notebookId);
      const notes = getFeaturedPathNoteCards(indexed, config);
      if (this.isDestroyed() || requestId !== this.featuredNotesRequestId || !empty.isConnected) return;

      let panel: HTMLElement;
      panel = this.createFeaturedNotesElement(notes, config, notebookId, () => {
        panel.remove();
        void this.appendFeaturedNotes(empty);
      });
      empty.append(panel);
    } catch {
      // Featured notes are an enhancement to the empty state. A failed or
      // unavailable memo query must never block starting a conversation.
    }
  }

  private createFeaturedNotesElement(
    notes: FeaturedNoteCard[],
    config: FeaturedNoteFilterConfig,
    notebookId: string,
    onFilterChange: () => void,
  ): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "agent-thread-card__featured-notes";
    panel.setAttribute("aria-label", this.t("editor.threadCard.featuredNotes"));

    let currentPage = 0;
    const mobileQuery = window.matchMedia(FEATURED_NOTES_MOBILE_QUERY);
    const getPageSize = (): number => mobileQuery.matches
      ? FEATURED_NOTE_MOBILE_PAGE_SIZE
      : FEATURED_NOTE_PAGE_SIZE;

    const navigation = document.createElement("div");
    navigation.className = "agent-thread-card__featured-notes-navigation";
    const previousButton = this.createFeaturedNotesNavigationButton(
      "‹",
      this.t("editor.threadCard.featuredNotes.previous"),
    );
    const nextButton = this.createFeaturedNotesNavigationButton(
      "›",
      this.t("editor.threadCard.featuredNotes.next"),
    );
    navigation.append(previousButton, nextButton);
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "agent-thread-card__featured-notes-settings-button";
    settingsButton.textContent = this.t("editor.threadCard.featuredNotes.settings");
    settingsButton.setAttribute("aria-expanded", "false");
    const settingsFooter = document.createElement("div");
    settingsFooter.className = "agent-thread-card__featured-notes-settings-footer";
    settingsFooter.append(settingsButton, navigation);

    const settingsPopover = this.createFeaturedNotesSettingsPopover(
      config,
      async (nextConfig) => {
        // 写入失败向上抛给 submit 处理器链; 这里先落盘成功再重建卡片列表,
        // 避免"界面已变但磁盘没变"的不一致。
        await writeFeaturedNoteFilter(notebookId, nextConfig);
        onFilterChange();
      },
    );
    /**
     * 弹层挂到 document.body 而不是设置按钮旁边 ── 与 composer 的模型/权限
     * 弹窗同款做法 (见 composer-dom-factory.ts 中 codexSettingsPopover 直接
     * append 到 body)。
     *
     * 挂在按钮旁边会有两个躲不掉的问题:
     *   1. 祖先 .agent-thread-card__body 是 overflow-y 滚动容器, 绝对定位的
     *      后代无法逃出它的裁剪, 弹层下缘会在 body 边界被切掉;
     *   2. 空状态下按钮贴着 body 底边, 下方就是 composer (z-index:1),
     *      弹层必须在更高的层叠上下文里才不会被压住。
     *
     * 放到 root 后弹层不受任何祖先裁剪与层叠影响, 再用 fixed + 视口坐标定位。
     */
    document.body.append(settingsPopover);
    /** 用 fixed 定位, 因此坐标基于视口, 与祖先滚动无关。 */
    const positionSettingsPopover = (): void => {
      if (settingsPopover.hidden || !settingsPopover.isConnected) return;
      const buttonRect = settingsButton.getBoundingClientRect();
      const popoverRect = settingsPopover.getBoundingClientRect();
      applyPopoverPosition(
        settingsPopover,
        calculateAnchoredPopoverPosition({
          anchorRect: buttonRect,
          popoverWidth: popoverRect.width || FEATURED_NOTES_SETTINGS_POPOVER_WIDTH_PX,
          popoverHeight: popoverRect.height || 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          padding: FEATURED_NOTES_SETTINGS_POPOVER_VIEWPORT_PADDING_PX,
          offset: FEATURED_NOTES_SETTINGS_POPOVER_OFFSET_PX,
        }),
      );
    };
    const setSettingsOpen = (open: boolean): void => {
      settingsPopover.hidden = !open;
      settingsButton.setAttribute("aria-expanded", String(open));
      if (open) {
        positionSettingsPopover();
        settingsPopover.querySelector<HTMLInputElement>("input")?.focus();
      }
    };
    settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setSettingsOpen(settingsButton.getAttribute("aria-expanded") !== "true");
    });

    const list = document.createElement("div");
    list.className = "agent-thread-card__featured-notes-list";
    panel.append(list);
    panel.append(settingsFooter);

    const renderPage = (): void => {
      const pageSize = getPageSize();
      const pageCount = getFeaturedNotePageCountForSize(notes.length, pageSize);
      currentPage = Math.min(currentPage, pageCount - 1);
      const pageNotes = getFeaturedNotePage(notes, currentPage, pageSize);
      list.replaceChildren();
      list.dataset.cardCount = String(pageNotes.length);
      for (const note of pageNotes) {
        list.append(this.createFeaturedNoteCard(note, notebookId));
      }
      previousButton.disabled = currentPage === 0;
      nextButton.disabled = currentPage >= pageCount - 1;
      previousButton.hidden = pageCount <= 1;
      nextButton.hidden = pageCount <= 1;
    };

    previousButton.addEventListener("click", (event) => {
      event.stopPropagation();
      currentPage = Math.max(0, currentPage - 1);
      renderPage();
    });
    nextButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const pageCount = getFeaturedNotePageCountForSize(notes.length, getPageSize());
      currentPage = Math.min(pageCount - 1, currentPage + 1);
      renderPage();
    });
    const handleViewportChange = (): void => renderPage();
    const handleWindowResize = (): void => {
      if (!settingsPopover.hidden) positionSettingsPopover();
    };
    const handleOutsidePointer = (event: PointerEvent): void => {
      // 弹层已挂到 document.body, 不再是 panel 的后代; 只判断 panel 会把
      // "点击弹层内部" 误判成外部点击而立刻关掉, 因此这里要把弹层一并排除。
      const target = event.target as Node;
      if (panel.contains(target) || settingsPopover.contains(target)) return;
      setSettingsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || settingsPopover.hidden) return;
      setSettingsOpen(false);
      settingsButton.focus();
    };
    mobileQuery.addEventListener("change", handleViewportChange);
    window.addEventListener("resize", handleWindowResize);
    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleEscape);
    this.featuredNotesViewportCleanup = () => {
      mobileQuery.removeEventListener("change", handleViewportChange);
      window.removeEventListener("resize", handleWindowResize);
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleEscape);
      // 弹层挂在 document.body 上, 不随 panel 一起被移除, 必须显式清理,
      // 否则每次刷新精选笔记都会在 body 里留下一个孤儿弹层。
      settingsPopover.remove();
      this.featuredNotesViewportCleanup = null;
    };
    renderPage();
    return panel;
  }

  private createFeaturedNotesSettingsPopover(
    config: FeaturedNoteFilterConfig,
    onSave: (config: FeaturedNoteFilterConfig) => Promise<void>,
  ): HTMLDivElement {
    const popover = document.createElement("div");
    popover.className = "agent-thread-card__featured-notes-settings";
    popover.hidden = true;
    popover.addEventListener("mousedown", (event) => event.stopPropagation());
    popover.addEventListener("click", (event) => event.stopPropagation());

    // 标题沿用 composer 模型/权限弹窗的同一套标题样式与位置 (见 renderPopover)。
    const title = document.createElement("div");
    title.className = "agent-thread-card__codex-settings-title";
    title.textContent = this.t("editor.threadCard.featuredNotes.settingsTitle");
    popover.append(title);

    const form = document.createElement("form");

    // 每行是一条独立条件, 行间是并集关系。行的增删只操作 DOM, 保存时统一从
    // DOM 读回 —— 避免再维护一份与 DOM 平行的状态。
    const rows = document.createElement("div");
    rows.className = "agent-thread-card__featured-notes-settings-rows";
    form.append(rows);

    const actions = document.createElement("div");
    actions.className = "agent-thread-card__featured-notes-settings-actions";
    const addConditionButton = document.createElement("button");
    addConditionButton.type = "button";
    addConditionButton.className = "agent-thread-card__featured-notes-settings-add-condition";
    addConditionButton.append(createPlusIcon(), document.createTextNode(
      this.t("editor.threadCard.featuredNotes.addCondition"),
    ));
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = this.t("common.cancel");
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "agent-thread-card__featured-notes-settings-save";
    saveButton.textContent = this.t("common.save");
    actions.append(addConditionButton, cancelButton, saveButton);
    form.append(actions);
    popover.append(form);

    /** 从当前 DOM 读回全部条件 (含未归一化的原始输入)。 */
    const readConditionsFromRows = (): FeaturedNoteFilter[] =>
      Array.from(rows.querySelectorAll<HTMLElement>(
        ".agent-thread-card__featured-notes-settings-row",
      )).map((row) => ({
        key: row.querySelector<HTMLInputElement>('[name="key"]')?.value ?? "",
        operator: (row.querySelector<HTMLInputElement>('[name="operator"]')?.value
          ?? "equals") as FeaturedNoteFilterOperator,
        value: row.querySelector<HTMLInputElement>('[name="value"]')?.value ?? "",
      }));

    const syncConditionControls = (): void => {
      const rowCount = rows.childElementCount;
      // 只有一条条件时不允许删除 —— 零条件会让常用笔记永远为空。
      for (const remove of rows.querySelectorAll<HTMLButtonElement>(
        ".agent-thread-card__featured-notes-settings-remove-condition",
      )) {
        remove.hidden = rowCount <= 1;
      }
      // 达到上限后禁用"添加条件", 避免弹层无限变长。
      const atLimit = rowCount >= MAX_FEATURED_NOTE_CONDITIONS;
      addConditionButton.disabled = atLimit;
      addConditionButton.title = atLimit
        ? this.t("editor.threadCard.featuredNotes.addConditionLimit")
        : "";
    };

    const appendConditionRow = (condition: FeaturedNoteFilter): void => {
      const row = this.createFeaturedNotesConditionRow(condition, {
        onRemove: () => {
          row.remove();
          syncConditionControls();
        },
      });
      rows.append(row);
      syncConditionControls();
    };

    const initialConditions = normalizeFeaturedNoteFilterConfig(config).conditions;
    for (const condition of initialConditions) appendConditionRow(condition);

    addConditionButton.addEventListener("click", () => {
      if (rows.childElementCount >= MAX_FEATURED_NOTE_CONDITIONS) return;
      // 新行给空值, 由用户填写; 保存时 normalize 会丢弃未填完的行。
      appendConditionRow({ key: "", operator: "equals", value: "" });
      rows.lastElementChild
        ?.querySelector<HTMLInputElement>('[name="key"]')
        ?.focus();
    });

    cancelButton.addEventListener("click", () => {
      popover.hidden = true;
      popover.parentElement
        ?.querySelector<HTMLButtonElement>(".agent-thread-card__featured-notes-settings-button")
        ?.setAttribute("aria-expanded", "false");
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      // 落盘走 IPC (笔记本文件夹内的 system.json), 因此是异步的。提交期间禁用
      // 保存按钮, 避免重复提交; 失败时保留弹层并提示, 让用户可以重试。
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      const clearError = (): void => {
        form.querySelector(".agent-thread-card__featured-notes-settings-error")?.remove();
      };
      clearError();
      onSave({ conditions: readConditionsFromRows() }).catch(() => {
        // 保存失败必须让用户看到: 静默失败会让人以为配置已经生效。
        const error = document.createElement("div");
        error.className = "agent-thread-card__featured-notes-settings-error";
        error.setAttribute("role", "alert");
        error.textContent = this.t("editor.threadCard.featuredNotes.saveFailed");
        form.append(error);
      }).finally(() => {
        if (popover.isConnected) saveButton.disabled = false;
      });
    });
    return popover;
  }

  /**
   * 构建一行筛选条件: [key 输入] [条件下拉] [value 输入] [删除]。
   *
   * 行的三个输入都是该行私有的, 因此下拉的展开状态、选项列表都随行创建, 行与行
   * 之间互不影响。
   */
  private createFeaturedNotesConditionRow(
    condition: FeaturedNoteFilter,
    handlers: { onRemove: () => void },
  ): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "agent-thread-card__featured-notes-settings-row";

    // 字段不显示独立标签, 改用 placeholder 提示。仍用 <label> 包裹以保留
    // 点击聚焦与无障碍关联。
    const keyField = document.createElement("label");
    keyField.className = "agent-thread-card__featured-notes-settings-field-key";
    const keyInput = document.createElement("input");
    keyInput.name = "key";
    keyInput.value = condition.key;
    keyInput.required = true;
    keyInput.autocomplete = "off";
    keyInput.placeholder = this.t("editor.threadCard.featuredNotes.propertyKeyPlaceholder");
    keyField.append(keyInput);

    const operatorField = document.createElement("label");
    operatorField.className = "agent-thread-card__featured-notes-settings-field-operator";
    const operatorInput = document.createElement("input");
    operatorInput.type = "hidden";
    operatorInput.name = "operator";
    operatorInput.value = condition.operator;
    const operatorSelect = document.createElement("div");
    operatorSelect.className = "agent-thread-card__featured-notes-operator-select";
    const operatorTrigger = document.createElement("button");
    operatorTrigger.type = "button";
    operatorTrigger.className = "agent-thread-card__featured-notes-operator-trigger";
    operatorTrigger.setAttribute("aria-haspopup", "listbox");
    operatorTrigger.setAttribute("aria-expanded", "false");
    const operatorValue = document.createElement("span");
    const operatorChevron = createChevronIcon("down");
    operatorTrigger.append(operatorValue, operatorChevron);
    const operatorMenu = document.createElement("div");
    operatorMenu.className = "agent-thread-card__featured-notes-operator-menu";
    operatorMenu.setAttribute("role", "listbox");
    operatorMenu.hidden = true;
    const operators = [
      ["equals", "editor.threadCard.featuredNotes.operator.equals"],
      ["contains", "editor.threadCard.featuredNotes.operator.contains"],
    ] as const;
    const operatorButtons: HTMLButtonElement[] = [];
    const setOperatorOpen = (open: boolean): void => {
      operatorMenu.hidden = !open;
      operatorTrigger.setAttribute("aria-expanded", String(open));
      operatorSelect.dataset.state = open ? "open" : "closed";
    };
    const selectOperator = (value: FeaturedNoteFilter["operator"]): void => {
      // 下拉里已不再提供 excludes。历史配置可能仍存着它, 若只回落显示而不归一化,
      // 隐藏域会继续保留 excludes, 与用户看到的"等于"不一致并被原样写回。
      const selected = operators.find(([candidate]) => candidate === value) ?? operators[0];
      operatorInput.value = selected[0];
      operatorValue.textContent = this.t(selected[1]);
      for (const button of operatorButtons) {
        const isSelected = button.dataset.value === selected[0];
        button.dataset.selected = String(isSelected);
        button.setAttribute("aria-selected", String(isSelected));
        button.querySelector(".agent-thread-card__featured-notes-operator-check")
          ?.classList.toggle("is-visible", isSelected);
      }
      setOperatorOpen(false);
    };
    for (const [value, labelKey] of operators) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.value = value;
      option.setAttribute("role", "option");
      const optionText = document.createElement("span");
      optionText.textContent = this.t(labelKey);
      const check = createCheckIcon();
      check.classList.add("agent-thread-card__featured-notes-operator-check");
      option.append(optionText, check);
      option.addEventListener("click", () => selectOperator(value));
      operatorButtons.push(option);
      operatorMenu.append(option);
    }
    operatorTrigger.addEventListener("click", () => {
      setOperatorOpen(operatorTrigger.getAttribute("aria-expanded") !== "true");
    });
    operatorTrigger.addEventListener("keydown", (event) => {
      const currentIndex = operators.findIndex(([value]) => value === operatorInput.value);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = (currentIndex + direction + operators.length) % operators.length;
        selectOperator(operators[nextIndex][0]);
        operatorTrigger.focus();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setOperatorOpen(false);
      }
    });
    operatorSelect.append(operatorInput, operatorTrigger, operatorMenu);
    operatorField.append(operatorSelect);
    selectOperator(condition.operator);
    row.addEventListener("pointerdown", (event) => {
      if (!operatorSelect.contains(event.target as Node)) setOperatorOpen(false);
    });

    const valueField = document.createElement("label");
    valueField.className = "agent-thread-card__featured-notes-settings-field-value";
    const valueInput = document.createElement("input");
    valueInput.name = "value";
    valueInput.value = condition.value;
    valueInput.required = true;
    valueInput.autocomplete = "off";
    valueInput.placeholder = this.t("editor.threadCard.featuredNotes.propertyValuePlaceholder");
    valueField.append(valueInput);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "agent-thread-card__featured-notes-settings-remove-condition";
    removeButton.setAttribute(
      "aria-label",
      this.t("editor.threadCard.featuredNotes.removeCondition"),
    );
    removeButton.title = this.t("editor.threadCard.featuredNotes.removeCondition");
    removeButton.append(createTrashIcon());
    removeButton.addEventListener("click", () => handlers.onRemove());

    row.append(keyField, operatorField, valueField, removeButton);
    return row;
  }

  private createFeaturedNotesNavigationButton(
    text: string,
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-thread-card__featured-notes-nav";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    return button;
  }

  private createFeaturedNoteCard(note: FeaturedNoteCard, notebookId: string): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agent-thread-card__featured-note";
    card.setAttribute("aria-label", [note.name, note.title, note.description].filter(Boolean).join(" — "));

    const icon = document.createElement("span");
    icon.className = "agent-thread-card__featured-note-icon";
    icon.setAttribute("aria-hidden", "true");
    appendFeaturedNoteIconContent(icon, note.icon);

    const content = document.createElement("span");
    content.className = "agent-thread-card__featured-note-content";
    const title = document.createElement("span");
    title.className = "agent-thread-card__featured-note-title";
    title.textContent = note.name ? `${note.name} › ${note.title}` : note.title;
    const description = document.createElement("span");
    description.className = "agent-thread-card__featured-note-description";
    description.textContent = note.description;
    content.append(title, description);
    // 图标独占首行 (原先这一行右侧还有个「试试」按钮, 已移除)。
    card.append(icon, content);

    card.addEventListener("click", (event) => {
      event.stopPropagation();
      // 点击 = 把这条笔记作为行内引用追加到 composer 输入框 (而不是打开笔记)。
      // 宿主未接该回调时 (例如独立的设置预览) 退化为打开笔记。
      if (this.onSelectFeaturedNote) {
        this.onSelectFeaturedNote({
          id: note.id,
          filename: note.title,
          title: note.title,
          notebookId,
          relativePath: note.id,
        });
        return;
      }
      void openNoteByNotebookPath(notebookId, note.id);
    });
    card.addEventListener("mousedown", (event) => event.stopPropagation());
    return card;
  }


}
