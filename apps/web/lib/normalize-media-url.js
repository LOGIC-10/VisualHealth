"use client";

export function toSameOriginMediaUrl(rawUrl, mediaBase) {
  if (!rawUrl) return null;
  if (typeof window === 'undefined') return rawUrl;
  try {
    const absolute = new URL(rawUrl, window.location.origin);
    if (absolute.origin === window.location.origin) {
      return absolute.href;
    }
    const base = new URL(mediaBase, window.location.origin);
    const basePath = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
    const targetPath = absolute.pathname.startsWith('/') ? absolute.pathname : `/${absolute.pathname}`;
    base.pathname = `${basePath}${targetPath}`;
    base.search = absolute.search;
    base.hash = '';
    return base.href;
  } catch (err) {
    console.warn('normalize media url failed', err);
    return rawUrl;
  }
}

