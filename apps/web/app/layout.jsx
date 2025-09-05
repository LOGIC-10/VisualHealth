export const metadata = {
  title: 'VisualHealth',
  description: 'Global heart sound analysis and community'
};

import './globals.css';
import { cookies, headers } from 'next/headers';
import Nav from '../components/Nav';
import { I18nProvider } from '../components/i18n';

export default function RootLayout({ children }) {
  const store = cookies();
  let lang = (store.get('vh_lang')?.value === 'zh') ? 'zh' : (store.get('vh_lang')?.value === 'en' ? 'en' : null);
  if (!lang) {
    // Fallback to Accept-Language on SSR when cookie is missing
    const accept = headers().get('accept-language') || '';
    lang = /^zh\b/i.test(accept) ? 'zh' : 'en';
  }
  const theme = (store.get('vh_theme')?.value === 'dark') ? 'dark' : 'light';
  return (
    <html lang={lang} data-lang={lang} data-theme={theme}>
      <body>
        <I18nProvider initialLang={lang}>
          <Nav initialLang={lang} initialTheme={theme} />
          <main>{children}</main>
        </I18nProvider>
      </body>
    </html>
  );
}
