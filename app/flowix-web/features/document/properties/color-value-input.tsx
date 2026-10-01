import { Check, ChevronDown } from 'lucide-react';
import { NOTE_COLORS, NOTE_COLOR_HEX } from '@features/memo/store/note-store';
import type { NoteColor } from '@/types/note-item';
import type { I18nKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@shared/ui/dropdown-menu';

const COLOR_LABEL_KEYS: Record<NoteColor, I18nKey> = {
  red: 'document.color.red',
  orange: 'document.color.orange',
  yellow: 'document.color.yellow',
  green: 'document.color.green',
  cyan: 'document.color.cyan',
  blue: 'document.color.blue',
  gray: 'document.color.gray',
};

function parseColors(value: string): NoteColor[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is NoteColor => NOTE_COLORS.includes(item as NoteColor));
}

export function ColorValueInput({
  value,
  disabled = false,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const { t } = useI18n();
  const selected = new Set(parseColors(value));

  const toggle = (color: NoteColor) => {
    const next = new Set(selected);
    if (next.has(color)) next.delete(color);
    else next.add(color);
    onChange(NOTE_COLORS.filter((item) => next.has(item)).join(', '));
  };

  const clear = () => onChange('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-2 text-left text-sm',
            'hover:bg-[var(--muted)]/40 focus-visible:border-[var(--primary)] focus-visible:outline-none',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
            {parseColors(value).map((color) => (
              <span
                key={color}
                aria-label={t(COLOR_LABEL_KEYS[color])}
                className="h-3.5 w-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: NOTE_COLOR_HEX[color] }}
              />
            ))}
            {parseColors(value).length === 0 && (
              <span className="text-[var(--muted-foreground)]">{t('document.properties.select.placeholder')}</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-[200px] rounded-xl border-[var(--border-popup)] p-2 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--muted-foreground)]">{t('document.properties.type.color')}</span>
          <button
            type="button"
            onClick={clear}
            className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            {t('document.color.clear')}
          </button>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {NOTE_COLORS.map((color) => {
            const isSelected = selected.has(color);
            return (
              <button
                key={color}
                type="button"
                aria-label={t(COLOR_LABEL_KEYS[color])}
                aria-pressed={isSelected}
                onClick={() => toggle(color)}
                className="relative flex h-8 items-center justify-center rounded-md border border-transparent hover:border-[var(--border)]"
              >
                <span
                  className="h-5 w-5 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0_/_0.12)]"
                  style={{ backgroundColor: NOTE_COLOR_HEX[color] }}
                />
                {isSelected && <Check className="absolute h-3.5 w-3.5 text-white" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
