const pick = (value, fallback) => {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return fallback;
};

export const API = {
  auth: pick(process.env.NEXT_PUBLIC_API_AUTH, '/api/auth'),
  media: pick(process.env.NEXT_PUBLIC_API_MEDIA, '/api/media'),
  analysis: pick(process.env.NEXT_PUBLIC_API_ANALYSIS, '/api/analysis'),
  feed: pick(process.env.NEXT_PUBLIC_API_FEED, '/api/feed'),
  viz: pick(process.env.NEXT_PUBLIC_API_VIZ, '/api/viz'),
  llm: pick(process.env.NEXT_PUBLIC_API_LLM, '/api/llm')
};

export const apiPath = (service, suffix = '') => {
  const base = API[service];
  if (!base) throw new Error(`Unknown API service: ${service}`);
  if (!suffix) return base;
  if (base.endsWith('/') && suffix.startsWith('/')) return `${base}${suffix.slice(1)}`;
  if (!base.endsWith('/') && !suffix.startsWith('/')) return `${base}/${suffix}`;
  return `${base}${suffix}`;
};
