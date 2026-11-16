import { apiKeyHashOf, generateApiKey } from './api-key';
import type { ApiKeysRepository } from './api-keys.repository';
import type { ProjectsRepository } from './projects.repository';
import { ProjectsService } from './projects.service';

const PROJECT_ID = '3a7c9e1b-2d4f-4a6b-8c0d-111111111111';
const API_KEY_ID = '3a7c9e1b-2d4f-4a6b-8c0d-333333333333';

type Repositories = {
  findActiveByHash: jest.Mock;
  findAllowedReturnOrigins: jest.Mock;
};

const repositoriesWith = (
  allowedOrigins: string[] | null = [],
): Repositories => ({
  findActiveByHash: jest
    .fn()
    .mockResolvedValue({ projectId: PROJECT_ID, apiKeyId: API_KEY_ID }),
  findAllowedReturnOrigins: jest.fn().mockResolvedValue(allowedOrigins),
});

const serviceWith = (repositories: Repositories): ProjectsService =>
  new ProjectsService(
    {
      findActiveByHash: repositories.findActiveByHash,
    } as unknown as ApiKeysRepository,
    {
      findAllowedReturnOrigins: repositories.findAllowedReturnOrigins,
    } as unknown as ProjectsRepository,
  );

describe('ProjectsService', () => {
  describe('findProjectAccess', () => {
    it('looks the key up by the hash of the whole key', async () => {
      const repositories = repositoriesWith();
      const apiKey = generateApiKey();

      await expect(
        serviceWith(repositories).findProjectAccess(apiKey),
      ).resolves.toEqual({ projectId: PROJECT_ID, apiKeyId: API_KEY_ID });
      expect(repositories.findActiveByHash).toHaveBeenCalledWith(
        apiKeyHashOf(apiKey),
      );
    });

    it.each([
      ['the old local key', 'local-dev-api-key'],
      ['a key of the wrong length', `pv_test_${'a'.repeat(42)}`],
      ['an empty token', ''],
    ])('refuses %s without a lookup', async (_case, apiKey) => {
      const repositories = repositoriesWith();

      await expect(
        serviceWith(repositories).findProjectAccess(apiKey),
      ).resolves.toBeNull();
      expect(repositories.findActiveByHash).not.toHaveBeenCalled();
    });
  });

  describe('isReturnUrlAllowed', () => {
    it('checks the URL against the origins of the given project', async () => {
      const repositories = repositoriesWith(['https://shop.example']);
      const service = serviceWith(repositories);

      await expect(
        service.isReturnUrlAllowed(PROJECT_ID, 'https://shop.example/return'),
      ).resolves.toBe(true);
      await expect(
        service.isReturnUrlAllowed(PROJECT_ID, 'https://evil.test/return'),
      ).resolves.toBe(false);
      expect(repositories.findAllowedReturnOrigins).toHaveBeenCalledWith(
        PROJECT_ID,
      );
    });

    it('refuses every URL for an unknown project', async () => {
      await expect(
        serviceWith(repositoriesWith(null)).isReturnUrlAllowed(
          PROJECT_ID,
          'https://shop.example/return',
        ),
      ).resolves.toBe(false);
    });
  });
});
