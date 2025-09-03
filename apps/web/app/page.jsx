export default function HomePage() {
  return (
    <div>
      <section style={{ minHeight: '80vh', display: 'grid', alignItems: 'center', padding: '80px 24px', background: 'linear-gradient(180deg,#f8fafc,#fff)' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h1 style={{ fontSize: 56, lineHeight: 1.05, margin: 0 }}>Hear your heart. Understand your health.</h1>
          <p style={{ fontSize: 20, color: '#334155', marginTop: 16 }}>Upload heart sound recordings to visualize waveforms and spectrograms, extract insights, and share with a global community.</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <a href="/analyze" style={{ padding: '12px 16px', background: '#111', color: '#fff', borderRadius: 12, textDecoration: 'none' }}>Get Started</a>
            <a href="/community" style={{ padding: '12px 16px', background: '#e5e7eb', color: '#111', borderRadius: 12, textDecoration: 'none' }}>Explore Community</a>
          </div>
        </div>
      </section>
      <section style={{ padding: '64px 24px', background: '#fff' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 12 }}>Heart Sound 101</h2>
          <p style={{ color: '#475569' }}>Heart sounds (S1, S2) arise from valve closures; murmurs may indicate turbulent flow. Visualizing waveforms and spectrograms helps contextualize intensity, timing, and frequency bands.</p>
        </div>
      </section>
      <section style={{ padding: '64px 24px', background: '#f8fafc' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 12 }}>About VisualHealth</h2>
          <p style={{ color: '#475569' }}>An open, modular platform for heart sound analysis. Privacy-first storage, per-service data isolation, and a growing library of analysis modules.</p>
        </div>
      </section>
    </div>
  );
}

