import { describe, expect, it } from 'vitest';

import { memoMatchesCustomFilter, type CustomFilter } from './custom-filter-store';
import type { MemoItem } from '@/types/memo-item';

const memo: MemoItem = {
  id: 'memo-1',
  filename: 'note.md',
  preview: '',
  tags: [],
  todos: [],
  agents: [],
  createdAt: 0,
  updatedAt: 0,
  favorited: false,
  icon: null,
  colors: [],
  properties: {
    status: 'in progress',
    labels: ['work', 'important'],
  },
};

function filter(operator: CustomFilter['operator'], key: string, value: string): CustomFilter {
  return { id: 'filter-1', name: 'test', documentType: 'note', operator, key, value };
}

describe('memoMatchesCustomFilter', () => {
  it('matches scalar properties with contains and equals', () => {
    expect(memoMatchesCustomFilter(memo, filter('contains', 'status', 'progress'))).toBe(true);
    expect(memoMatchesCustomFilter(memo, filter('equals', 'status', 'in progress'))).toBe(true);
    expect(memoMatchesCustomFilter(memo, filter('equals', 'status', 'progress'))).toBe(false);
  });

  it('matches a value inside list properties', () => {
    expect(memoMatchesCustomFilter(memo, filter('contains', 'labels', 'important'))).toBe(true);
    expect(memoMatchesCustomFilter(memo, filter('equals', 'labels', 'work'))).toBe(true);
  });
});
