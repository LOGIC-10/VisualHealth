it('provides core translations for nav and hero copy', async () => {
  const { dict } = await import('../components/i18n.js');
  expect(dict.en.Analysis).toBe('Analysis');
  expect(dict.en.HomeHeroTitle).toContain('Hear your heart');
  expect(dict.en.Login).toBe('Login');
});
