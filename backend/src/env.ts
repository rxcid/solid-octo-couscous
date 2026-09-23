import { existsSync } from "node:fs";

// Load backend/.env when present. Variables already set in the environment win.
if (existsSync(".env")) process.loadEnvFile(".env");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see backend/.env.example)`);
  }
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  HOST: process.env.HOST ?? "localhost",
  PORT: Number(process.env.PORT ?? 4000),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:3000",
};
