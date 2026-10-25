/** Keep controls and pointer targets intact when workspace ownership changes. */
export function syncFrontmatterEditability(root: HTMLElement, editable: boolean) {
  root.querySelectorAll<HTMLElement>(
    '.frontmatter-property__display .frontmatter-property__type-icon,'
    + ' .frontmatter-property__display-key,'
    + ' .frontmatter-property__display-value:not([data-property-type="Image"])',
  ).forEach((control) => {
    control.toggleAttribute('tabindex', editable);
    if (editable) control.tabIndex = 0;
    if (editable) control.setAttribute('role', 'button');
    else control.removeAttribute('role');
    if (!control.classList.contains('frontmatter-property__type-icon')) return;
    if (editable) {
      control.setAttribute('aria-haspopup', 'menu');
      control.setAttribute('aria-expanded', control.getAttribute('aria-expanded') ?? 'false');
      control.setAttribute('aria-label', control.closest<HTMLElement>('[data-property-key]')?.dataset.propertyKey ?? control.title);
      control.setAttribute('aria-grabbed', control.getAttribute('aria-grabbed') ?? 'false');
    } else {
      for (const attribute of ['aria-haspopup', 'aria-expanded', 'aria-label', 'aria-grabbed']) {
        control.removeAttribute(attribute);
      }
    }
  });
  root.querySelectorAll<HTMLInputElement>('.frontmatter-property__value-checkbox').forEach((checkbox) => {
    checkbox.disabled = !editable;
  });
}
