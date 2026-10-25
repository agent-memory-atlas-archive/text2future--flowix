import { describe, expect, it } from 'vitest';
import { NoteMetadataProjection } from './note-metadata';

const original = { icon: 'book', colors: [], favorited: true };
describe('note metadata projection', () => {
  it('rejects reads started before a newer event', () => {
    const projection = new NoteMetadataProjection();
    const checkpoint = projection.checkpoint();
    projection.update('/notes/deep/a.md', original);
    projection.mergeSnapshot('/notes/deep/a.md', { ...original, icon: 'old' }, checkpoint);
    expect(projection.get('/notes/deep/a.md').value).toEqual(original);
  });
  it('preserves unavailable metadata but accepts explicit clears', () => {
    const projection = new NoteMetadataProjection();
    projection.update('/a.md', original);
    projection.mergeSnapshot('/a.md', null, projection.checkpoint());
    expect(projection.get('/a.md')).toMatchObject({ status: 'stale', value: original });
    projection.mergeSnapshot('/a.md', { icon: null, colors: [], favorited: false }, projection.checkpoint());
    expect(projection.get('/a.md')).toMatchObject({ status: 'ready', value: { icon: null, favorited: false } });
  });
  it('keeps deleted descendants deleted when an index is unavailable', () => {
    const projection = new NoteMetadataProjection();
    projection.update('/folder/a.md', original);
    projection.update('/folder-other/a.md', original);
    const beforeDeletion = projection.checkpoint();
    projection.deletePrefix('/folder');
    projection.mergeSnapshot('/folder/a.md', original, beforeDeletion);
    projection.mergeSnapshot('/folder/a.md', null, projection.checkpoint());
    expect(projection.get('/folder/a.md').status).toBe('deleted');
    expect(projection.get('/folder-other/a.md').status).toBe('ready');
    projection.mergeSnapshot('/folder/a.md', original, projection.checkpoint());
    expect(projection.get('/folder/a.md').status).toBe('ready');
  });
  it('preserves deletion through invalidation and unavailable reads', () => {
    const projection = new NoteMetadataProjection();
    projection.update('/a.md', original);
    projection.deletePrefix('/a.md');
    projection.invalidate('/a.md');
    projection.mergeSnapshot('/a.md', null, projection.checkpoint());
    expect(projection.get('/a.md').status).toBe('deleted');
    projection.mergeSnapshot('/a.md', original, projection.checkpoint());
    expect(projection.get('/a.md').status).toBe('ready');
  });
  it('keeps active read barriers and rejects snapshots predating eviction', () => {
    const projection = new NoteMetadataProjection();
    const checkpoint = projection.checkpoint();
    const release = projection.retainRead('/active.md');
    projection.update('/active.md', original);
    projection.update('/evicted.md', original);
    for (let index = 0; index < 5010; index++) projection.update(`/${index}.md`, original);
    expect(projection.get('/active.md').value).toEqual(original);
    expect(projection.get('/evicted.md').status).toBe('pending');
    projection.mergeSnapshot('/evicted.md', { ...original, icon: 'old' }, checkpoint);
    expect(projection.get('/evicted.md').status).toBe('pending');
    release();
    for (let index = 5010; index < 10020; index++) projection.update(`/${index}.md`, original);
    expect(projection.get('/active.md').status).toBe('pending');
  });
  it('rejects outstanding reads after cache reset', () => {
    const projection = new NoteMetadataProjection();
    const checkpoint = projection.checkpoint();
    projection.clear();
    projection.mergeSnapshot('/a.md', original, checkpoint);
    expect(projection.get('/a.md').status).toBe('pending');
  });
  it('bounds retained entries while preserving mounted consumers', () => {
    const projection = new NoteMetadataProjection();
    const stop = projection.subscribe('/mounted.md', () => {});
    projection.update('/mounted.md', original);
    for (let index = 0; index < 5010; index++) projection.update(`/${index}.md`, original);
    expect(projection.paths()).toHaveLength(5000);
    expect(projection.get('/mounted.md').value).toEqual(original);
    stop();
  });
});
