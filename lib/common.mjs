import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { findWindowsGcloud, windowsGcloudCommand } from './windows-gcloud.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const central = 'sharedbank-connect';
export const workerUrl = 'https://sharedbank-switch.e-commerce-sriramtpsiog.workers.dev';
export const workerName = 'sharedbank-switch';
export const workerIdentity = 'x42-worker@sharedbank-connect.iam.gserviceaccount.com';
export const expectedOrigins = ['https://sriramtpsiog.github.io', 'https://sowndhariyasaravanan.github.io'];
export const configure = fileURLToPath(new URL('../support/worker/tools/configure.mjs', import.meta.url));

export function run(command, args, opts = {}) {
  if (command === 'gcloud' && process.platform === 'win32') {
    const invocation = windowsGcloudCommand(findWindowsGcloud(opts.env || process.env), args);
    return execFileSync(invocation.command, invocation.args, opts);
  }
  // Git Bash can use the Unix npm and npx launchers on Windows.
  if (process.platform === 'win32' && ['npm', 'npx'].includes(command)) {
    return execFileSync('bash', ['-c', 'if command -v "$1" >/dev/null; then exec "$@"; fi; cmd="$1.cmd"; shift; exec "$cmd" "$@"', 'x42', command, ...args], opts);
  }
  try { return execFileSync(command, args, opts); }
  catch (error) {
    if (command === 'gcloud' && error.code === 'ENOENT') {
      throw new Error('Google Cloud CLI (gcloud) was not found. Install it or add it to PATH, then rerun setup.');
    }
    throw error;
  }
}

export const cli = (cmd, args, opts = {}) => run(cmd, args, { stdio: 'inherit', ...opts });
export const output = (cmd, args, opts = {}) => run(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
export const gcloud = args => cli('gcloud', args);
export const googleToken = () => output('gcloud', ['auth', 'print-access-token', '--quiet']);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function loadConfig(file) {
  return validateConfig(JSON.parse(await readFile(file, 'utf8')));
}

export function validateConfig(config) {
  const checks = {
    bankId: /^P\d{3}$/,
    bankName: /^.{2,100}$/u,
    ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
    firebaseProjectId: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    firestoreLocation: /^[a-z][a-z0-9-]{2,25}$/,
    githubOwner: /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i,
    githubRepo: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    testUserEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    accountId: /^[A-Za-z0-9_-]{1,80}$/,
    accountNumber: /^[A-Za-z0-9-]{4,40}$/,
    brandColor: /^#[a-f\d]{6}$/i,
  };
  for (const [key, re] of Object.entries(checks)) {
    if (typeof config[key] !== 'string' || !re.test(config[key]) || config[key].trim() !== config[key]) {
      throw new Error('Invalid or missing ' + key + ' in bank.json.');
    }
  }
  if (config.firebaseProjectId === central) throw new Error('A bank needs its own Firebase project.');
  if (!Number.isSafeInteger(config.openingBalancePaise) || config.openingBalancePaise < 0) {
    throw new Error('openingBalancePaise must be a non-negative integer.');
  }
  if (config.firebaseWebAppId !== undefined &&
      (typeof config.firebaseWebAppId !== 'string' || !/^1:\d+:web:[a-f0-9]+$/i.test(config.firebaseWebAppId))) {
    throw new Error('firebaseWebAppId must be a Firebase Web app ID.');
  }
  return Object.fromEntries([...Object.keys(checks), 'openingBalancePaise', 'firebaseWebAppId']
    .filter(key => config[key] !== undefined).map(key => [key, config[key]]));
}

export const originOf = config => 'https://' + config.githubOwner.toLowerCase() + '.github.io';
export const portalOf = config => originOf(config) + '/' +
  (config.githubRepo.toLowerCase() === config.githubOwner.toLowerCase() + '.github.io' ? '' : config.githubRepo + '/');

export class HttpError extends Error {
  constructor(status, data) {
    super(data?.error?.message || 'HTTP ' + status);
    this.status = status;
    this.code = data?.error?.status;
  }
}

export async function request(url, { method = 'GET', token, project, body, headers } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(token && { Authorization: 'Bearer ' + token }),
      ...(project && { 'x-goog-user-project': project }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(response.status, value);
  return value;
}

export function configureBank(args) {
  cli(process.execPath, [configure, ...args], { env: { ...process.env, CENTRAL_PROJECT_ID: central } });
}
