import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

describe('middleware', () => {
  it('sets default language and theme cookies', () => {
    const req = new NextRequest('https://app.example.com/dashboard');
    const res = middleware(req);
    expect(res.cookies.get('vh_lang')?.value).toBe('en');
    expect(res.cookies.get('vh_theme')?.value).toBe('light');
  });

  it('detects zh locale from accept-language header', () => {
    const req = new NextRequest('https://app.example.com/', {
      headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.5' }
    });
    const res = middleware(req);
    expect(res.cookies.get('vh_lang')?.value).toBe('zh');
  });

  it('preserves existing valid cookies and corrects invalid theme', () => {
    const req = new NextRequest('https://app.example.com/profile', {
      headers: {
        cookie: 'vh_lang=en; vh_theme=neon'
      }
    });
    const res = middleware(req);
    expect(res.cookies.get('vh_lang')).toBeUndefined();
    expect(res.cookies.get('vh_theme')?.value).toBe('light');
  });
});
