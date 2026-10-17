// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Markdown, isMarkdown } from './Markdown';

afterEach(cleanup);

/** The shape of a delivered price sheet: headings, a table with a divider row,
 * bold emphasis and inline code naming the source document. */
const PRICE_SHEET = `# KlikPop price sheet: standard line

**Status:** DRAFT v1.0 · Owner: Meera Bose
Prices come from \`supplier_shortlist.md\` and are **not** signed off.

| Format | Unit cost | Retail | Margin |
|:---|---:|---:|---:|
| 1-key | $3.20 | $18.00 | 82% |
| 2-key | $4.10 | $24.00 | 83% |
| 3-key | $5.05 | $29.00 | 83% |

Sources: *internal* memory entry "Mission".
`;

/** The shape of a delivered landing page: a heading ladder and paragraphs. */
const LANDING_PAGE = `# KlikPop: a switch you can carry

## Why a keychain
A real mechanical switch under a real keycap. It clicks because the switch clicks.

### The standard line
- 1-key, 2-key and 3-key formats
  - replaceable top cover
  - custom keycaps with your own art
- Ships worldwide from small batch production

### What is not ready
All prices are **draft values** pending sign-off.

---

## Custom orders
Send art or text; we print the cover.
`;

it('renders headings at their level', () => {
  render(<Markdown source={LANDING_PAGE} />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('KlikPop: a switch you can carry');
  const level2 = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(level2).toEqual(['Why a keychain', 'Custom orders']);
  expect(screen.getByRole('heading', { level: 3, name: /The standard line/ })).toBeTruthy();
});

it('renders a pipe table with its header, rows and alignment', () => {
  const { container } = render(<Markdown source={PRICE_SHEET} />);
  const table = container.querySelector('table');
  expect(table).toBeTruthy();
  expect([...container.querySelectorAll('th')].map((th) => th.textContent)).toEqual([
    'Format',
    'Unit cost',
    'Retail',
    'Margin',
  ]);
  const rows = container.querySelectorAll('tbody tr');
  expect(rows.length).toBe(3);
  expect([...rows[1].querySelectorAll('td')].map((td) => td.textContent)).toEqual(['2-key', '$4.10', '$24.00', '83%']);
  // A leading colon means the column is left aligned, a trailing one right align.
  expect(container.querySelectorAll('th')[0].style.textAlign).toBe('left');
  expect(container.querySelectorAll('th')[1].style.textAlign).toBe('right');
  // The divider row is not data.
  expect(container.textContent).not.toContain('---');
});

it('renders bold, italic and inline code as elements', () => {
  const { container } = render(<Markdown source={PRICE_SHEET} />);
  const strong = [...container.querySelectorAll('strong')].map((el) => el.textContent);
  expect(strong).toContain('Status:');
  expect(strong).toContain('not');
  expect(container.querySelector('code')?.textContent).toBe('supplier_shortlist.md');
  expect(container.querySelector('em')?.textContent).toBe('internal');
});

it('does not italicise an underscore inside a file name', () => {
  const { container } = render(<Markdown source="See shipping_returns_warranty.md for the policy." />);
  expect(container.querySelector('em')).toBeNull();
  expect(container.textContent).toBe('See shipping_returns_warranty.md for the policy.');
});

it('keeps a fenced block verbatim, markdown characters and all', () => {
  const { container } = render(
    <Markdown source={'```json\n{"price": "**not bold**", "note": "# not a heading"}\n```\n'} />,
  );
  const pre = container.querySelector('pre');
  expect(pre?.textContent).toBe('{"price": "**not bold**", "note": "# not a heading"}');
  expect(container.querySelector('strong')).toBeNull();
  expect(container.querySelector('h1')).toBeNull();
});

it('renders ordered, unordered and nested list items', () => {
  const { container } = render(
    <Markdown source={'1. First\n2. Second\n\n- Parent\n  - Child\n- Sibling\n'} />,
  );
  expect(container.querySelectorAll('ol > li').length).toBe(2);

  const [rootList] = container.querySelectorAll('ul');
  expect([...rootList.children].map((li) => li.firstChild?.textContent)).toEqual(['Parent', 'Sibling']);
  const nested = rootList.querySelector('li > ul');
  expect([...(nested?.children ?? [])].map((li) => li.textContent)).toEqual(['Child']);
});

it('draws a horizontal rule', () => {
  const { container } = render(<Markdown source={'Above\n\n---\n\nBelow\n'} />);
  expect(container.querySelector('hr')).toBeTruthy();
  expect(container.textContent).toContain('Above');
  expect(container.textContent).toContain('Below');
});

it('never injects delivered HTML, it prints it', () => {
  const { container } = render(
    <Markdown source={'Look: <img src="x" onerror="alert(1)"> and <script>alert(2)</script>'} />,
  );
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<img src="x" onerror="alert(1)">');
});

it('chooses markdown by extension, because delivered .md files are labelled text/plain', () => {
  expect(isMarkdown('support_playbook.md', 'text/plain')).toBe(true);
  expect(isMarkdown('NOTES.MARKDOWN', 'text/plain')).toBe(true);
  expect(isMarkdown('page.html', 'text/html')).toBe(false);
  expect(isMarkdown('data.json', 'application/json')).toBe(false);
  expect(isMarkdown('something', 'text/markdown')).toBe(true);
});
