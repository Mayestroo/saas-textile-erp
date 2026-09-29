import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const apiDirectory = join(repositoryRoot, 'apps', 'api');
const envPath = join(apiDirectory, '.env');
const requiredSecrets = [
  'PLATFORM_JWT_ACCESS_SECRET',
  'PLATFORM_JWT_REFRESH_SECRET',
  'TENANT_JWT_ACCESS_SECRET',
  'TENANT_JWT_REFRESH_SECRET',
  'AUTH_LOGIN_BUCKET_HASH_SECRET'
];

if (!existsSync(envPath)) {
  throw new Error('apps/api/.env is missing; copy apps/api/.env.example and configure the local database first.');
}

const original = readFileSync(envPath, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);
const generated = [];

function fileValue(name) {
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (line === undefined) return undefined;
  let value = line.slice(name.length + 1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }
  return value;
}

function currentValue(name) {
  const processValue = process.env[name];
  if (processValue !== undefined && processValue.trim().length > 0) return processValue;
  const storedValue = fileValue(name);
  return storedValue?.trim().length ? storedValue : undefined;
}

function setMissingValue(name, value) {
  if (currentValue(name) !== undefined) return;
  if (!value) {
    throw new Error(`${name} is missing; configure it in apps/api/.env for local development.`);
  }
  const serialized = /^[A-Za-z0-9_./:@-]+$/.test(value)
    ? value
    : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const lineIndex = lines.findIndex((candidate) => candidate.startsWith(`${name}=`));
  if (lineIndex < 0) lines.push(`${name}=${serialized}`);
  else lines[lineIndex] = `${name}=${serialized}`;
  generated.push(name);
}

for (const name of requiredSecrets) {
  const processValue = process.env[name];
  if (processValue !== undefined && processValue.length > 0) {
    if (Buffer.byteLength(processValue, 'utf8') < 32) {
      throw new Error(`${name} is set in the shell but must contain at least 32 UTF-8 bytes.`);
    }
    continue;
  }

  const existingValue = fileValue(name);
  if (existingValue !== undefined && existingValue.length > 0) {
    if (Buffer.byteLength(existingValue, 'utf8') < 32) {
      throw new Error(`${name} is already set in apps/api/.env but is shorter than 32 UTF-8 bytes; replace it locally.`);
    }
    continue;
  }

  const secret = randomBytes(32).toString('base64url');
  const lineIndex = lines.findIndex((candidate) => candidate.startsWith(`${name}=`));
  if (lineIndex < 0) lines.push(`${name}=${secret}`);
  else lines[lineIndex] = `${name}=${secret}`;
  generated.push(name);
}

const masterHost = currentValue('MASTER_DB_HOST') ?? 'localhost';
const masterPort = currentValue('MASTER_DB_PORT') ?? '5432';
setMissingValue('TENANT_DB_HOST', masterHost);
setMissingValue('TENANT_DB_PORT', masterPort);
setMissingValue('TENANT_PROVISIONER_DB_HOST', masterHost);
setMissingValue('TENANT_PROVISIONER_DB_PORT', masterPort);
setMissingValue('TENANT_PROVISIONER_DB_NAME', 'postgres');
setMissingValue('TENANT_PROVISIONER_DB_USER', currentValue('MASTER_DB_USER'));
setMissingValue('TENANT_PROVISIONER_DB_PASSWORD', currentValue('MASTER_DB_PASSWORD'));
setMissingValue('TENANT_CONNECTION_ENCRYPTION_KEY', randomBytes(32).toString('base64url'));

const configuredSecrets = requiredSecrets.map((name) => currentValue(name));
if (configuredSecrets.some((value) => value === undefined) || new Set(configuredSecrets).size !== requiredSecrets.length) {
  throw new Error('Local authentication secrets must all be set and distinct; update apps/api/.env.');
}

if (generated.length > 0) {
  const temporaryPath = `${envPath}.dev-secrets.tmp`;
  writeFileSync(temporaryPath, lines.join(newline), { encoding: 'utf8', flag: 'w' });
  renameSync(temporaryPath, envPath);
  process.stdout.write(`Prepared local API development settings: ${generated.join(', ')}\n`);
} else {
  process.stdout.write('Local API development settings are configured.\n');
}
