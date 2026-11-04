import { FakeProvider } from './fake/fake.provider';
import { ProviderRegistry } from './provider.registry';

describe('ProviderRegistry', () => {
  const fakeProvider = new FakeProvider(Buffer.alloc(32, 1));
  const registry = new ProviderRegistry(fakeProvider);

  it('gets a stored provider by code', () => {
    expect(registry.get('fake').code).toBe('fake');
  });

  it('finds a known code', () => {
    expect(registry.find('fake')).toBe(fakeProvider);
  });

  it.each(['stripe', 'constructor', '__proto__', 'toString', ''])(
    'returns null for %j',
    (code) => {
      expect(registry.find(code)).toBeNull();
    },
  );
});
