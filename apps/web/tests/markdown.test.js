import { renderMarkdown } from '../components/markdown.js';

describe('renderMarkdown', () => {
  it('converts headings, lists, and inline formatting', () => {
    const md = ['# Title', '', '- item **bold**', '', 'Plain *italic* text'].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<ul><li>item <strong>bold</strong></li></ul>');
    expect(html).toContain('<p>Plain <em>italic</em> text</p>');
  });

  it('escapes raw HTML and preserves code fences', () => {
    const md = ['```', '<script>alert("x")</script>', '```'].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('&lt;script&gt;alert(');
    expect(html).toContain('&lt;/script&gt;');
    expect(html.startsWith('<pre><code>')).toBe(true);
  });
});
