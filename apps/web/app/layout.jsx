export const metadata = {
  title: 'VisualHealth',
  description: 'Global heart sound analysis and community'
};

import './globals.css';
import Nav from '../components/Nav';

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-lang="en" data-theme="light">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
