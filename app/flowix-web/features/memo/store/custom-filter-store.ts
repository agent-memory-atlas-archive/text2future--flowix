import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { STORAGE_KEYS } from '@/lib/constants';
import type { MemoItem, PathNoteListItem } from '@/types/memo-item';

export type CustomFilterOperator = 'contains' | 'equals';

export interface CustomFilter {
  id: string;
  name: string;
  key: string;
  operator: CustomFilterOperator;
  value: string;
}

interface CustomFilterStore {
  filters: CustomFilter[];
  addFilter: (filter: Omit<CustomFilter, 'id'>) => string;
  updateFilter: (id: string, filter: Omit<CustomFilter, 'id'>) => void;
  removeFilter: (id: string) => void;
}

function createFilterId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `custom-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function valueParts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(valueParts);
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

/** Match user-defined frontmatter properties without changing the file format. */
export function memoMatchesCustomFilter(memo: Pick<MemoItem | PathNoteListItem, 'properties'>, filter: CustomFilter): boolean {
  const actualValues = valueParts(memo.properties?.[filter.key]);
  const expected = filter.value.trim();
  if (!expected || actualValues.length === 0) return false;

  if (filter.operator === 'contains') {
    const normalizedExpected = expected.toLocaleLowerCase();
    return actualValues.some((actual) => actual.toLocaleLowerCase().includes(normalizedExpected));
  }

  return actualValues.some((actual) => actual === expected);
}

export const useCustomFilterStore = create<CustomFilterStore>()(
  persist(
    (set) => ({
      filters: [],
      addFilter: (filter) => {
        const id = createFilterId();
        set((state) => ({ filters: [...state.filters, { ...filter, id }] }));
        return id;
      },
      updateFilter: (id, filter) => set((state) => ({
        filters: state.filters.map((item) => item.id === id ? { ...filter, id } : item),
      })),
      removeFilter: (id) => set((state) => ({
        filters: state.filters.filter((filter) => filter.id !== id),
      })),
    }),
    { name: STORAGE_KEYS.CUSTOM_FILTER },
  ),
);
