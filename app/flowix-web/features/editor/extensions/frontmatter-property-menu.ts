import { translate } from '@/lib/i18n';
import { getCurrentAppLanguage } from '@features/preferences/public/runtime-api';

export type PropertyMenuAction = 'up' | 'down' | 'delete';

/** Shared menu for saved properties. */
export function createPropertyItemMenu(
  anchor: HTMLElement,
  propertyKey: string,
  index: number,
  count: number,
  onAction: (action: PropertyMenuAction) => void,
): HTMLElement {
  const ownerDocument = anchor.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const menu = ownerDocument.createElement('div');
  menu.className = 'frontmatter-property__item-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', propertyKey);
  const actions = [
    ['up', 'document.properties.moveUp', index <= 0],
    ['down', 'document.properties.moveDown', index < 0 || index >= count - 1],
    ['delete', 'document.properties.deleteProperty', false],
  ] as const;
  actions.forEach(([action, label, disabled]) => {
    const button = ownerDocument.createElement('button');
    button.className = 'frontmatter-property__item-menu-button';
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = translate(getCurrentAppLanguage(), label);
    button.disabled = disabled;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (!button.disabled) onAction(action);
    });
    menu.append(button);
  });
  const bounds = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(8, bounds.left)}px`;
  menu.style.top = `${Math.max(8, bounds.bottom + 4)}px`;
  ownerDocument.body.append(menu);
  const menuBounds = menu.getBoundingClientRect();
  if (menuBounds.right > ownerWindow.innerWidth - 8) {
    menu.style.left = `${Math.max(8, ownerWindow.innerWidth - menuBounds.width - 8)}px`;
  }
  if (menuBounds.bottom > ownerWindow.innerHeight - 8) {
    menu.style.top = `${Math.max(8, bounds.top - menuBounds.height - 4)}px`;
  }
  return menu;
}
