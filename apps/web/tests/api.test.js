describe('API helper', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_API_AUTH;
    delete process.env.NEXT_PUBLIC_API_MEDIA;
    delete process.env.NEXT_PUBLIC_API_ANALYSIS;
    delete process.env.NEXT_PUBLIC_API_FEED;
    delete process.env.NEXT_PUBLIC_API_VIZ;
    delete process.env.NEXT_PUBLIC_API_LLM;
    jest.resetModules();
  });

  it('defaults to internal rewrites when env unset', async () => {
    const mod = await import('../lib/api.js');
    expect(mod.API.auth).toBe('/api/auth');
    expect(mod.apiPath('media')).toBe('/api/media');
  });

  it('joins paths without duplicating slashes', async () => {
    process.env.NEXT_PUBLIC_API_MEDIA = 'https://example.test/api/media';
    jest.resetModules();
    const mod = await import('../lib/api.js');
    expect(mod.apiPath('media', '/upload')).toBe('https://example.test/api/media/upload');
    process.env.NEXT_PUBLIC_API_MEDIA = 'https://example.test/api/media/';
    jest.resetModules();
    const modTrailing = await import('../lib/api.js');
    expect(modTrailing.apiPath('media', 'upload')).toBe('https://example.test/api/media/upload');
  });
});
