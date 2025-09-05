export const metadata = {
  title: 'VisualHealth',
  description: 'Global heart sound analysis and community'
};

import './globals.css';
import { cookies } from 'next/headers';
import Nav from '../components/Nav';

export default function RootLayout({ children }) {
  const store = cookies();
  const lang = (store.get('vh_lang')?.value === 'zh') ? 'zh' : 'en';
  const theme = (store.get('vh_theme')?.value === 'dark') ? 'dark' : 'light';
  return (
    <html lang={lang} data-lang={lang} data-theme={theme}>
      <body>
        <Nav initialLang={lang} initialTheme={theme} />
        <main>{children}</main>
      </body>
    </html>
  );
}
