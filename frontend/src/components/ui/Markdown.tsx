import { useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * A small markdown renderer for delivered files, no dependency.
 *
 * Safety: the source is parsed into blocks and inline runs, and every run of
 * text becomes a React text node, which React escapes on the way out. Nothing
 * here builds an HTML string and nothing sets innerHTML, so a file containing
 * `<script>` prints the tag instead of running it.
 *
 * Scope is what agents actually deliver: headings, paragraphs, bold, italic,
 * inline code, fenced blocks, lists (nested one level deep), horizontal rules
 * and pipe tables. Anything else stays readable text.
 */

type Align = 'left' | 'center' | 'right';

interface ListItem {
  text: string;
  ordered: boolean;
  children: ListItem[];
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'rule' }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] };

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Split a pipe-table row into cells; `\|` stays inside a cell. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function startsBlock(line: string, next?: string): boolean {
  if (!line.trim()) return true;
  if (FENCE.test(line)) return true;
  if (HEADING.test(line)) return true;
  if (RULE.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (line.includes('|') && next !== undefined && TABLE_DIVIDER.test(next) && next.includes('-')) return true;
  return false;
}

function parseList(lines: string[], start: number): { items: ListItem[]; next: number } {
  const flat: { indent: number; text: string; ordered: boolean }[] = [];
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first ? first[1].length : 0;
  const baseOrdered = first ? /\d/.test(first[2]) : false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line is still an item.
      if (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
        i += 1;
        continue;
      }
      break;
    }
    const match = LIST_ITEM.exec(line);
    if (match) {
      const ordered = /\d/.test(match[2]);
      // A bullet after a numbered list at the same depth is a second list, not
      // a member of the first: the marker decides the tag.
      if (match[1].length === baseIndent && ordered !== baseOrdered) break;
      flat.push({ indent: match[1].length, text: match[3], ordered });
      i += 1;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent > 0 && flat.length > 0) {
      // A wrapped continuation belongs to the item above it.
      flat[flat.length - 1].text += ` ${line.trim()}`;
      i += 1;
      continue;
    }
    break;
  }

  const roots: ListItem[] = [];
  const stack: { indent: number; item: ListItem }[] = [];
  for (const entry of flat) {
    const node: ListItem = { text: entry.text, ordered: entry.ordered, children: [] };
    while (stack.length > 0 && entry.indent < stack[stack.length - 1].indent) stack.pop();
    if (stack.length > 0 && entry.indent === stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && entry.indent > parent.indent) parent.item.children.push(node);
    else roots.push(node);
    stack.push({ indent: entry.indent, item: node });
  }
  return { items: roots, next: i };
}

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence, or the end of the file
      blocks.push({ kind: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, index) => cells[index] ?? ''));
        i += 1;
      }
      blocks.push({ kind: 'table', align, head, rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push({ kind: 'list', items: parsed.items });
      i = parsed.next;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(lines[i], lines[i + 1])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    else i += 1;
  }
  return blocks;
}

const INLINE_SOURCE = '(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(__[^_]+__)|(\\*[^*\\n]+\\*)|(_[^_\\n]+_)';

const isWord = (ch: string | undefined): boolean => !!ch && /[\w]/.test(ch);

/** Inline runs: code, bold, italic. Everything else is a plain text node. */
function renderInline(text: string, key: string): ReactNode[] {
  // A fresh regex per call: the recursion below must not share a lastIndex.
  const inline = new RegExp(INLINE_SOURCE, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  let match: RegExpExecArray | null;
  while ((match = inline.exec(text)) !== null) {
    const token = match[0];
    // `shipping_returns_warranty.md` is a file name, not emphasis.
    if (token.startsWith('_') && (isWord(text[match.index - 1]) || isWord(text[match.index + token.length]))) {
      continue;
    }
    if (match.index > last) out.push(text.slice(last, match.index));
    n += 1;
    if (token.startsWith('`')) {
      out.push(
        <code key={`${key}-c${n}`} className="rounded bg-slate-800/80 px-1 py-0.5 font-mono text-[11px] text-emerald-200">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(
        <strong key={`${key}-b${n}`} className="font-semibold text-slate-100">
          {renderInline(token.slice(2, -2), `${key}-b${n}`)}
        </strong>,
      );
    } else {
      out.push(
        <em key={`${key}-i${n}`} className="italic">
          {renderInline(token.slice(1, -1), `${key}-i${n}`)}
        </em>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderList(items: ListItem[], key: string): ReactNode {
  const ordered = items[0]?.ordered ?? false;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag key={key} className={cn('my-1 space-y-0.5 pl-5 text-slate-300', ordered ? 'list-decimal' : 'list-disc')}>
      {items.map((item, index) => (
        <li key={`${key}-${index}`} className="pl-0.5">
          {renderInline(item.text, `${key}-${index}`)}
          {item.children.length > 0 && renderList(item.children, `${key}-${index}-sub`)}
        </li>
      ))}
    </Tag>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mb-1.5 mt-4 font-semibold text-sm text-slate-100 first:mt-0',
  2: 'mb-1.5 mt-3 font-semibold text-[13px] text-slate-100',
  3: 'mb-1 mt-3 font-semibold text-xs text-slate-200',
  4: 'mb-1 mt-2 font-semibold text-xs text-slate-300',
  5: 'mb-1 mt-2 font-medium text-xs text-slate-300',
  6: 'mb-1 mt-2 font-medium text-xs text-slate-400',
};

function renderBlock(block: Block, index: number): ReactNode {
  const key = `md-${index}`;
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${Math.min(Math.max(block.level, 1), 6)}` as 'h1';
      return <Tag key={key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[6]}>{renderInline(block.text, key)}</Tag>;
    }
    case 'paragraph':
      return <p key={key} className="my-1.5 text-slate-300">{renderInline(block.text, key)}</p>;
    case 'code':
      return (
        <pre key={key} className="my-2 max-h-72 overflow-auto rounded border border-slate-800/70 bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          <code>{block.text}</code>
        </pre>
      );
    case 'rule':
      return <hr key={key} className="my-3 border-slate-800" />;
    case 'list':
      return renderList(block.items, key);
    case 'table':
      return (
        <div key={key} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                {block.head.map((cell, cellIndex) => (
                  <th
                    key={`${key}-h${cellIndex}`}
                    style={{ textAlign: block.align[cellIndex] ?? 'left' }}
                    className="border-b border-slate-700 px-2 py-1 font-medium text-slate-200"
                  >
                    {renderInline(cell, `${key}-h${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-r${rowIndex}`} className="align-top">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-r${rowIndex}c${cellIndex}`}
                      style={{ textAlign: block.align[cellIndex] ?? 'left' }}
                      className="border-b border-slate-800/70 px-2 py-1 text-slate-300"
                    >
                      {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return <div className={cn('text-[12px] leading-relaxed text-slate-300', className)}>{blocks.map(renderBlock)}</div>;
}

/** Markdown is chosen by extension: the API labels delivered .md files text/plain. */
export function isMarkdown(name: string, mime?: string | null): boolean {
  if (/\.(md|markdown|mdx)$/i.test(name)) return true;
  return mime === 'text/markdown' || mime === 'text/x-markdown';
}
