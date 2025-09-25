/** @jest-environment jsdom */

import { toSameOriginMediaUrl } from '../lib/normalize-media-url.js';

describe('toSameOriginMediaUrl', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://app.example.com/dashboard')
    });
  });

  it('returns same-origin url unchanged', () => {
    const result = toSameOriginMediaUrl('https://app.example.com/file/123');
    expect(result).toBe('https://app.example.com/file/123');
  });

  it('rehosts foreign url onto configured media base', () => {
    const mediaBase = 'https://app.example.com/api/media';
    const result = toSameOriginMediaUrl('https://cdn.example.com/file/abc', mediaBase);
    expect(result).toBe('https://app.example.com/api/media/file/abc');
  });

  it('leaves relative paths untouched when already same origin', () => {
    const mediaBase = '/api/media/';
    const result = toSameOriginMediaUrl('file/def', mediaBase);
    expect(result).toBe('https://app.example.com/file/def');
  });
});
