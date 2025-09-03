export const metadata = {
  title: 'VisualHealth',
  description: 'Global heart sound analysis and community'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'ui-sans-serif, system-ui, -apple-system' }}>
        <nav style={{ position: 'sticky', top: 0, zIndex: 10, backdropFilter: 'saturate(180%) blur(20px)', background: 'rgba(255,255,255,0.6)', borderBottom: '1px solid #eee', display: 'flex', gap: 16, padding: '12px 24px' }}>
          <a href="/" style={{ fontWeight: 700, textDecoration: 'none', color: '#111' }}>VisualHealth</a>
          <div style={{ display: 'flex', gap: 12 }}>
            <a href="/analyze">Analyze</a>
            <a href="/community">Community</a>
            <a href="/settings">Settings</a>
            <a href="/auth">Login</a>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
