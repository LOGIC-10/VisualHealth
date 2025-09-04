"use client";

// Minimal Markdown renderer for headings, bold/italic, lists and code blocks.
// It escapes HTML first to avoid injection, then applies simple replacements.
export function renderMarkdown(md) {
  if (!md || typeof md !== 'string') return '';

  const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = md.split(/\r?\n/);
  let html = '';
  let inCode = false;
  let inList = false;
  let paraBuf = [];

  const flushPara = () => {
    if (!paraBuf.length) return;
    const text = paraBuf.join(' ');
    html += `<p>${inline(text)}</p>`;
    paraBuf = [];
  };

  const closeList = () => {
    if (inList) { html += '</ul>'; inList = false; }
  };

  const inline = (s) => {
    // Work on escaped text so user HTML cannot inject tags
    let t = escapeHtml(s);
    // bold **text**
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // italic *text*
    t = t.replace(/(^|\W)\*(?!\*)([^*]+?)\*(?=\W|$)/g, '$1<em>$2</em>');
    // inline code `code`
    t = t.replace(/`([^`]+?)`/g, '<code>$1</code>');
    return t;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      if (!inCode) {
        flushPara();
        closeList();
        inCode = true;
        html += '<pre><code>';
      } else {
        inCode = false;
        html += '</code></pre>';
      }
      continue;
    }
    if (inCode) {
      html += `${escapeHtml(raw)}\n`;
      continue;
    }

    if (!trimmed) {
      flushPara();
      closeList();
      continue;
    }

    const h = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      closeList();
      const level = Math.min(6, (trimmed.match(/^#+/) || [''])[0].length);
      html += `<h${level}>${inline(h[1])}</h${level}>`;
      continue;
    }

    const li = /^[-*]\s+(.*)$/.exec(trimmed);
    if (li) {
      flushPara();
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }

    // paragraph accumulation
    paraBuf.push(trimmed);
  }

  // close any open blocks
  if (inCode) html += '</code></pre>';
  closeList();
  flushPara();

  return html;
}

