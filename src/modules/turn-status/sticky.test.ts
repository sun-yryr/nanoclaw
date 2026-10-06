import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearStickyTurnStatus,
  getStickyTurnStatusId,
  resetStickyTurnStatus,
  setStickyTurnStatusId,
  turnStatusKey,
} from './sticky.js';

describe('turn-status sticky map', () => {
  beforeEach(() => {
    resetStickyTurnStatus();
  });

  it('stores and clears per session destination', () => {
    const key = turnStatusKey('sess-1', 'discord:g:c', null);
    expect(getStickyTurnStatusId(key)).toBeUndefined();
    setStickyTurnStatusId(key, 'plat-msg-1');
    expect(getStickyTurnStatusId(key)).toBe('plat-msg-1');
    clearStickyTurnStatus(key);
    expect(getStickyTurnStatusId(key)).toBeUndefined();
  });

  it('isolates thread slots', () => {
    setStickyTurnStatusId(turnStatusKey('s', 'p', null), 'a');
    setStickyTurnStatusId(turnStatusKey('s', 'p', 'thread-1'), 'b');
    expect(getStickyTurnStatusId(turnStatusKey('s', 'p', null))).toBe('a');
    expect(getStickyTurnStatusId(turnStatusKey('s', 'p', 'thread-1'))).toBe('b');
  });
});
