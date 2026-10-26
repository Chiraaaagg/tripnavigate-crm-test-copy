import { describe, expect, it } from 'vitest';
import { markdownTargets, referenceTarget } from '../../scripts/ci/check-doc-links.mjs';

const targets = (text: string) => markdownTargets(text).map((t) => t.target);

describe('Markdown link checker', () => {
  it('finds inline links and path-shaped reference definitions', () => {
    const text = ['See [a](a.md) and ![b](img/b.png "title").', '', '[ref]: ../c.md'].join('\n');
    expect(markdownTargets(text)).toEqual([
      { line: 1, target: 'a.md' },
      { line: 1, target: 'img/b.png' },
      { line: 3, target: '../c.md' },
    ]);
  });

  it('skips footnotes and reference definitions that are not paths', () => {
    expect(referenceTarget('[^1]: a footnote with a/slash')).toBeUndefined();
    expect(referenceTarget('[Note]: see below')).toBeUndefined();
    expect(referenceTarget('[x]: ./x')).toBe('./x');
    expect(referenceTarget('[x]: #section')).toBe('#section');
    expect(referenceTarget('[x]: guide.md')).toBe('guide.md');
    expect(referenceTarget('[x]: folder/file')).toBe('folder/file');
  });

  it('ignores inline code and fenced code at any indentation', () => {
    const text = [
      'Inline `[x](missing.md)` is code.',
      '1. Step one',
      '',
      '      ```sh',
      '   [y](missing-in-fence.md)',
      '      ```',
      '',
      '~~~',
      '[z](missing-tilde.md)',
      '~~~',
      '[ok](ok.md)',
    ].join('\n');
    expect(targets(text)).toEqual(['ok.md']);
  });

  it('ignores indented code blocks, also inside list items', () => {
    const text = [
      'Paragraph',
      '',
      '    [top](missing-top.md)',
      '',
      '- Item',
      '',
      '      [nested](missing-nested.md)',
      '',
      '  [para](item-paragraph.md)',
      '',
      '1. Numbered',
      '    [lazy](continuation.md)',
    ].join('\n');
    expect(targets(text)).toEqual(['item-paragraph.md', 'continuation.md']);
  });
});
