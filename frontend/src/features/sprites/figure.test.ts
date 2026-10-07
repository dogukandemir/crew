import { describe, expect, it } from 'vitest';
import { figureCell } from './SpriteCharacter';

/**
 * The floor's rule about faces, as assertions: only somebody working at their own
 * desk looks away from the room. A back turned all day is what "some characters
 * look permanently turned away" was — and a walker or a talker with their back to
 * the camera is the same complaint in miniature.
 */
describe('figureCell', () => {
  it('turns only someone working at their own desk away', () => {
    expect(figureCell('typing', true, false, 0)).toEqual({ face: 'back', pose: 'sit' });
    expect(figureCell('tool', true, false, 0)).toEqual({ face: 'back', pose: 'sit' });
  });

  it('faces a seated person to the room whenever they are not working', () => {
    for (const kind of ['idle', 'thinking', 'talking', 'blocked', 'waiting', 'celebrating'] as const) {
      expect(figureCell(kind, true, false, 0)).toEqual({ face: 'front', pose: 'sit' });
    }
  });

  it('faces walkers and anyone on their feet to the camera', () => {
    expect(figureCell('walking', false, true, 0)).toEqual({ face: 'front', pose: 'walkA' });
    expect(figureCell('walking', false, true, 0.3)).toEqual({ face: 'front', pose: 'walkB' });
    expect(figureCell('idle', false, false, 0)).toEqual({ face: 'front', pose: 'stand' });
    expect(figureCell('typing', false, false, 0)).toEqual({ face: 'front', pose: 'stand' });
  });
});
