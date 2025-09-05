import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Language cookie
  let lang = req.cookies.get('vh_lang')?.value;
  if (!lang) {
    const accept = req.headers.get('accept-language') || '';
    // very simple zh detection
    lang = /^zh\b/i.test(accept) ? 'zh' : 'en';
    res.cookies.set('vh_lang', lang, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }

  // Theme cookie (default to light)
  let theme = req.cookies.get('vh_theme')?.value;
  if (theme !== 'light' && theme !== 'dark') {
    theme = 'light';
    res.cookies.set('vh_theme', theme, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }

  return res;
}

export const config = {
  matcher: [
    // run on all app routes
    '/((?!_next/|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|json)$).*)',
  ],
};

