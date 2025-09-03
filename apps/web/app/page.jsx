"use client";
import { useI18n } from '../components/i18n';

export default function HomePage() {
  const { t } = useI18n();
  return (
    <div>
      <section style={{ minHeight: '80vh', display: 'grid', alignItems: 'center', padding: '80px 24px' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h1 style={{ fontSize: 56, lineHeight: 1.05, margin: 0 }}>{t('HomeHeroTitle')}</h1>
          <p style={{ fontSize: 20, marginTop: 16 }}>{t('HomeHeroDesc')}</p>
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <a href="/analysis/new" style={{ padding: '12px 16px', background: '#111', color: '#fff', borderRadius: 12, textDecoration: 'none' }}>{t('GetStarted')}</a>
            <a href="/community" style={{ padding: '12px 16px', background: '#e5e7eb', color: '#111', borderRadius: 12, textDecoration: 'none' }}>{t('ExploreCommunity')}</a>
          </div>
        </div>
      </section>
      <section style={{ padding: '64px 24px' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 12 }}>{t('HeartSound101')}</h2>
          <p>{t('HeartSound101Desc')}</p>
        </div>
      </section>
      <section style={{ padding: '64px 24px' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 12 }}>{t('AboutVH')}</h2>
          <p>{t('AboutVHDesc')}</p>
        </div>
      </section>
    </div>
  );
}
