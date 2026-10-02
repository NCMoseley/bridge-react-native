import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().min(1).default('./data/bridge.sqlite'),
  ADMIN_API_KEY: z.string().min(24),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32).optional(),
  PROXY_WEBHOOK_SECRET: z.string().min(1).optional(),
  EMAIL_INGEST_SECRET: z.string().min(1).optional(),
  TEST_USER_EMAIL: z.email().optional(),
  INITIAL_USER_PASSWORD: z.preprocess((value) => value === '' ? undefined : value, z.string().min(12).optional()),
  SESSION_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  ADMIN_USER_EMAIL: z.preprocess((value) => value === '' ? undefined : value, z.email().optional()),
});

export const config = configSchema.parse({
  PORT: process.env.PORT,
  DATABASE_PATH: process.env.DATABASE_PATH,
  ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
  CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY,
  PROXY_WEBHOOK_SECRET: process.env.PROXY_WEBHOOK_SECRET,
  EMAIL_INGEST_SECRET: process.env.EMAIL_INGEST_SECRET,
  TEST_USER_EMAIL: process.env.TEST_USER_EMAIL,
  INITIAL_USER_PASSWORD: process.env.INITIAL_USER_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET,
  ADMIN_USER_EMAIL: process.env.ADMIN_USER_EMAIL,
});

export const databasePath = path.resolve(config.DATABASE_PATH);
