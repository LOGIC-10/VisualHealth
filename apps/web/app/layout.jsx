export const metadata = {
  title: 'VisualHealth',
  description: 'Global heart sound analysis and community'
};

import Nav from '../components/Nav';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'ui-sans-serif, system-ui, -apple-system' }}>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
