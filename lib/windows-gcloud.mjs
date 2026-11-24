import { statSync } from 'node:fs';
import { win32 } from 'node:path';

const installSuffix = ['Google', 'Cloud SDK', 'google-cloud-sdk', 'bin'];
const names = ['gcloud.exe', 'gcloud.cmd', 'gcloud.bat'];
const isFile = file => statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

export function findWindowsGcloud(env = process.env, fileExists = isFile) {
  if (env.X42_GCLOUD_PATH) {
    if (!win32.isAbsolute(env.X42_GCLOUD_PATH) || !fileExists(env.X42_GCLOUD_PATH)) {
      throw new Error('X42_GCLOUD_PATH must be the full Windows path to an existing gcloud.cmd or gcloud.exe.');
    }
    return env.X42_GCLOUD_PATH;
  }

  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const paths = (env.PATH || env.Path || '').split(';').map(value => value.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const directories = [...paths, ...roots.map(root => win32.join(root, ...installSuffix))];
  for (const directory of directories) {
    if (!win32.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = win32.join(directory, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  throw new Error('Google Cloud CLI (gcloud) was not found. Install it from https://cloud.google.com/sdk/docs/install-sdk, reopen Git Bash, and run gcloud version. For a custom install, set X42_GCLOUD_PATH to the full Windows path to gcloud.cmd.');
}

export function windowsGcloudCommand(file, args) {
  if (!/\.(?:cmd|bat)$/i.test(file)) return { command: file, args };
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const script = '$ErrorActionPreference = "Stop"; $cliArgs = @(' + args.map(literal).join(',') +
    '); & ' + literal(file) + ' @cliArgs; exit $LASTEXITCODE';
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')] };
}
