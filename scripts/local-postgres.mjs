import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const DEFAULT_PORT = 55432;
const MAX_CONNECTIONS = 100;

const port = Number(process.env.LOCAL_POSTGRES_PORT ?? DEFAULT_PORT);
const db = await PGlite.create();
const server = new PGLiteSocketServer({
  db,
  port,
  maxConnections: MAX_CONNECTIONS,
});

await server.start();
process.stdout.write(
  [
    `In-memory Postgres on postgres://postgres@127.0.0.1:${port}/postgres`,
    'It runs one query at a time: set DATABASE_POOL_MAX=1 for the API and run e2e with --runInBand.',
    '',
  ].join('\n'),
);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
