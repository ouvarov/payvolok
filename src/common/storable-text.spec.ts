import { storableText } from './storable-text';

describe('storableText', () => {
  it('removes control characters and keeps other text', () => {
    expect(storableText('card\u0000 de\u0007clined\n é', 100)).toBe(
      'card declined é',
    );
  });

  it('caps the text after removing control characters', () => {
    expect(storableText(`\u0000${'a'.repeat(10)}`, 4)).toBe('aaaa');
  });
});
