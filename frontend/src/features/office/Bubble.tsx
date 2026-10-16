/**
 * A speech bubble, drawn upright above a character's head.
 *
 * Because the scene is a flat projection rather than a tilted 3D plane, "upright"
 * is free, the bubble is simply not rotated, and it stays legible at any zoom.
 *
 * The colour is the point: a chat, a piece of water-cooler gossip, a report to a
 * manager, a directive coming back down, an escalation and a hand-off each look
 * different at a glance, and the badge glyph says which without reading the text.
 * The words are always the real ones from the event; this component never writes.
 */
import type { SpeechKind } from '../../sim/activity';

const MAX_CHARS = 24;
const MAX_LINES = 2;
const CHAR_W = 5.4;
const LINE_H = 11.5;
const PAD_X = 8;
const PAD_Y = 5.5;

export interface BubbleSkin {
  fill: string;
  stroke: string;
  text: string;
  badge?: string;
}

export const BUBBLE_SKIN: Record<SpeechKind, BubbleSkin> = {
  talk: { fill: '#f2f6ff', stroke: '#a8bcdd', text: '#15233c' },
  gossip: { fill: '#ffe8c2', stroke: '#cf9a4a', text: '#4a3110', badge: '☕' },
  report: { fill: '#d8f6e3', stroke: '#6fb98f', text: '#0f3a22', badge: '↑' },
  directive: { fill: '#e7e1ff', stroke: '#9c8fe0', text: '#251a52', badge: '↓' },
  escalation: { fill: '#ffdcdd', stroke: '#df8484', text: '#4a1418', badge: '!' },
  delegation: { fill: '#e2f4ff', stroke: '#7cb6d9', text: '#0e3048', badge: '→' },
};

/** Wrap into at most `MAX_LINES` lines of `MAX_CHARS`, ellipsising the overflow. */
export function wrapSpeech(text: string): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= MAX_CHARS) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > MAX_CHARS ? `${word.slice(0, MAX_CHARS - 1)}…` : word;
    if (lines.length === MAX_LINES) break;
  }
  if (line && lines.length < MAX_LINES) lines.push(line);

  const used = lines.join(' ').length;
  if (used < text.trim().length && lines.length > 0) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.slice(0, MAX_CHARS - 1)}…`;
  }
  return lines.length > 0 ? lines : ['…'];
}

/**
 * A bubble centred on (0,0) at its tail tip, so the caller can attach it to
 * whatever it belongs to without measuring anything.
 */
export function Bubble({
  kind,
  text,
  to,
  maxWidth = 152,
}: {
  kind: SpeechKind;
  text: string;
  to?: string;
  maxWidth?: number;
}) {
  const skin = BUBBLE_SKIN[kind];
  const lines = wrapSpeech(text);
  const badgeW = skin.badge ? 16 : 0;
  const longest = Math.max(...lines.map((l) => l.length));
  const width = Math.min(maxWidth, Math.max(54, longest * CHAR_W + PAD_X * 2 + badgeW));
  const height = lines.length * LINE_H + PAD_Y * 2;
  const tail = 7;
  const left = -width / 2;
  const textX = skin.badge ? left + PAD_X + badgeW : 0;

  return (
    <g>
      <rect
        x={-width / 2}
        y={-height - tail}
        width={width}
        height={height}
        rx={7}
        fill={skin.fill}
        stroke={skin.stroke}
        strokeWidth={1}
      />
      {/* Tail, pointing down at the speaker. */}
      <path
        d={`M -5 ${-tail} L 5 ${-tail} L 0 ${-tail + 6} Z`}
        fill={skin.fill}
        stroke={skin.stroke}
        strokeWidth={1}
      />
      {skin.badge && (
        <text
          x={left + PAD_X - 1}
          y={-height - tail + PAD_Y + 10}
          fontSize={11}
          fontWeight={700}
          fill={skin.text}
          opacity={0.85}
        >
          {skin.badge}
        </text>
      )}
      {lines.map((line, i) => (
        <text
          key={i}
          x={textX}
          y={-height - tail + PAD_Y + 10 + i * LINE_H}
          fontSize={10.5}
          fill={skin.text}
          textAnchor={skin.badge ? 'start' : 'middle'}
        >
          {line}
        </text>
      ))}
    </g>
  );
}
