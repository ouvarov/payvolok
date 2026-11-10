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
