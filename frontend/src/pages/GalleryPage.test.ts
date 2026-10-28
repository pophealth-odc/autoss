import { describe, expect, it } from 'vitest';
import type { GalleryItem } from '../api/contract';
import { sortItems } from './GalleryPage';

function item(id: string, title: string, capturedAt: string): GalleryItem {
  return {
    id, filename: `${id}.png`, folder: '', title, url: `https://x.test/${id}`, finalUrl: `https://x.test/${id}`, capturedAt,
    width: 100, height: 100, bytes: 1, screenshotMode: 'fullPage', status: 'success', httpStatus: 200, warnings: [], runId: 'r',
  };
}

const items = [
  item('a', 'banana', '2026-01-02T00:00:00.000Z'),
  item('b', 'Apple', '2026-01-03T00:00:00.000Z'),
  item('c', '', '2026-01-04T00:00:00.000Z'),
  item('d', 'cherry', '2026-01-01T00:00:00.000Z'),
  item('e', 'apple 10', '2026-01-05T00:00:00.000Z'),
  item('f', 'apple 9', '2026-01-06T00:00:00.000Z'),
];

describe('sortItems', () => {
  it('newest first', () => {
    expect(sortItems(items, 'newest').map((i) => i.id)).toEqual(['f', 'e', 'c', 'b', 'a', 'd']);
  });

  it('oldest first', () => {
    expect(sortItems(items, 'oldest').map((i) => i.id)).toEqual(['d', 'a', 'b', 'c', 'e', 'f']);
  });

  it('by title: case-insensitive, natural numbers, untitled last', () => {
    expect(sortItems(items, 'title').map((i) => i.title)).toEqual(['Apple', 'apple 9', 'apple 10', 'banana', 'cherry', '']);
  });

  it('does not change the original array', () => {
    const copy = [...items];
    sortItems(items, 'title');
    expect(items).toEqual(copy);
  });
});
