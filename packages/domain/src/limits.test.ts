import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_ENTRIES,
  MAX_FILE_READ_BYTES,
  MAX_MULTI_FILE_BYTES,
  MAX_PROCESS_LOG_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
} from './limits.js';

describe('V1 resource limits', () => {
  it('exposes the approved bounded defaults', () => {
    expect({
      MAX_FILE_READ_BYTES,
      MAX_MULTI_FILE_BYTES,
      MAX_PROCESS_LOG_BYTES,
      DEFAULT_SEARCH_RESULTS,
      MAX_SEARCH_RESULTS,
      DEFAULT_TREE_DEPTH,
      MAX_TREE_DEPTH,
      DEFAULT_TREE_ENTRIES,
      MAX_TREE_ENTRIES,
    }).toEqual({
      MAX_FILE_READ_BYTES: 2 * 1024 * 1024,
      MAX_MULTI_FILE_BYTES: 4 * 1024 * 1024,
      MAX_PROCESS_LOG_BYTES: 10 * 1024 * 1024,
      DEFAULT_SEARCH_RESULTS: 200,
      MAX_SEARCH_RESULTS: 500,
      DEFAULT_TREE_DEPTH: 4,
      MAX_TREE_DEPTH: 8,
      DEFAULT_TREE_ENTRIES: 2000,
      MAX_TREE_ENTRIES: 5000,
    });
  });
});
