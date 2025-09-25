/** @jest-environment jsdom */

import {
  setGuestTransfer,
  consumeGuestTransfer,
  peekGuestTransfer,
  clearGuestTransfer
} from '../lib/guest-transfer.js';

describe('guest transfer helpers', () => {
  beforeEach(() => {
    clearGuestTransfer();
  });

  it('stores data on window and consumes it once', () => {
    const payload = { mediaId: 'x', filename: 'demo.wav' };
    setGuestTransfer(payload);
    expect(peekGuestTransfer()).toEqual(payload);
    expect(consumeGuestTransfer()).toEqual(payload);
    expect(peekGuestTransfer()).toBeNull();
  });

  it('clears data without throwing when window is blocked', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, '__vhGuestTransfer__');
    Object.defineProperty(window, '__vhGuestTransfer__', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
      set() {
        throw new Error('denied');
      }
    });

    expect(() => setGuestTransfer({})).not.toThrow();
    expect(peekGuestTransfer()).toBeNull();
    expect(consumeGuestTransfer()).toBeNull();
    expect(() => clearGuestTransfer()).not.toThrow();

    if (originalDescriptor) {
      Object.defineProperty(window, '__vhGuestTransfer__', originalDescriptor);
    } else {
      delete window.__vhGuestTransfer__;
    }
  });
});

