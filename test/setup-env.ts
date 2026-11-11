const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;

if (!e2eDatabaseUrl) {
  throw new Error(
    'Set E2E_DATABASE_URL to a throwaway database; e2e tests never read DATABASE_URL from .env',
  );
}

process.env.DATABASE_URL = e2eDatabaseUrl;
process.env.NODE_ENV = 'test';
process.env.API_KEY_SHA256 =
  '12ec8503ce99db70ceda90b0bb73acc059cd5bcacbb9bc7e175e9845a0186338';
process.env.PUBLIC_BASE_URL = 'https://payvolok.e2e.test';
// Blank, not deleted: ConfigModule would refill a missing key from .env, and blank reads as unset.
process.env.PADDLE_API_KEY = '';
process.env.PADDLE_WEBHOOK_SECRET = '';
process.env.PADDLE_CLIENT_TOKEN = '';

globalThis.fetch = () =>
  Promise.reject(new Error('e2e tests make no network calls'));
