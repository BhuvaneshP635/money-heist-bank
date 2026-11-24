import { cp, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { cli, expectedOrigins, originOf, output, portalOf, root, sleep, workerName, workerUrl } from './common.mjs';

async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function addOrigins(text, origins) {
  const pattern = /^([ \t]*FRONTEND_ORIGINS[ \t]*=[ \t]*)"([^"\r\n]*)"([ \t]*(?:#[^\r\n]*)?\r?)$/m;
  const match = text.match(pattern);
  if (!match) throw new Error('Expected a double-quoted FRONTEND_ORIGINS value in wrangler.toml.');
  const merged = [...new Set([...match[2].split(',').map(item => item.trim()).filter(Boolean), ...origins])];
  return text.replace(pattern, (_, prefix, _value, trailing) => prefix + '"' + merged.join(',') + '"' + trailing);
}

async function allowed(origin) {
  const response = await fetch(workerUrl + '/api/v1/directory/banks', { method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' }, signal: AbortSignal.timeout(12_000) });
  return response.status === 204 && response.headers.get('access-control-allow-origin') === origin;
}

export async function cloudflare(config, workerDir, deploy) {
  const origin = originOf(config);
  const directory = resolve(workerDir), file = join(directory, 'wrangler.toml');
  const before = await readFile(file, 'utf8');
  if (!new RegExp('^name\\s*=\\s*"'+workerName+'"\\s*$', 'm').test(before)) {
    throw new Error('Use the current checkout of the SharedDB Worker, sharedbank-switch.');
  }
  const clientFile = join(directory, 'src/firestore.mjs');
  const client = await readFile(clientFile, 'utf8');
  const legacyCall = /^([ \t]*)const response = await this\.fetcher\(this\.base \+ path, \{/m;
  const fixedClient = client.replace(legacyCall, (_, indent) =>
    indent + 'const send = this.fetcher;' + (client.includes('\r\n') ? '\r\n' : '\n') +
    indent + 'const response = await send(this.base + path, {');
  if (/await this\.fetcher\s*\(/.test(fixedClient)) {
    throw new Error('The Worker has a different Firestore client. Use the latest sharedbank-switch deployment checkout.');
  }
  const next = addOrigins(before, [...expectedOrigins, origin]);
  if (fixedClient !== client) {
    await writeFile(clientFile, fixedClient);
    console.log('Applied the Firestore fetch fix to ' + clientFile);
  }
  if (before !== next) {
    await writeFile(file, next);
    console.log('Added ' + origin + ' to ' + file);
  }
  if (!deploy) {
    console.log('Cloudflare config patched. Run the same command with --deploy to publish it.');
    return;
  }
  const checks = await Promise.all([...expectedOrigins, origin].map(allowed));
  if (fixedClient !== client || before !== next || !checks.every(Boolean)) {
    cli('npx', ['--no-install', 'wrangler', 'deploy', '--keep-vars', '--config', file], { cwd: directory });
  }
  console.log('Verifying the Worker allows ' + origin + ' …');
  if (!await allowed(origin)) throw new Error('The deployed Worker did not allow the bank origin.');
  if (!(await Promise.all(expectedOrigins.map(allowed))).every(Boolean)) throw new Error('An existing platform origin stopped responding after deployment.');
}

const gh = (args, cwd) => cli('gh', args, { cwd });
function ghJson(args, cwd) {
  try { return JSON.parse(output('gh', args, { cwd })); }
  catch (error) {
    if (/\bHTTP 404\b/.test(error.stderr || '')) return null;
    throw new Error('gh ' + args[0] + ' failed: ' + (error.stderr?.trim() || error.message));
  }
}

async function assemblePortal(target, config) {
  const src = join(root, 'bank-portal-template');
  const current = await readdir(target);
  const marker = join(target, '.x42-portal.json');
  if (await exists(marker)) {
    const previous = JSON.parse(await readFile(marker, 'utf8'));
    if (previous.bankId !== config.bankId) throw new Error('This checkout belongs to another bank.');
  } else {
    const unrelated = current.filter(name => !['.git', 'README.md', '.gitignore', 'LICENSE'].includes(name));
    if (unrelated.length) throw new Error('The repository has existing files. Use an empty repository or an existing X42 portal.');
    for (const name of await readdir(src)) {
      if (['node_modules', 'dist'].includes(name)) continue;
      if (name === 'README.md' && current.includes(name)) {
        const readme = (await readFile(join(target, name), 'utf8')).trim();
        if (readme !== '# ' + config.githubRepo) continue;
      }
      if (name === '.gitignore' && current.includes(name)) {
        const existing = (await readFile(join(target, name), 'utf8')).trimEnd();
        const template = (await readFile(join(src, name), 'utf8')).trimEnd();
        await writeFile(join(target, name), existing + '\n' + template + '\n');
        continue;
      }
      await cp(join(src, name), join(target, name), { recursive: true });
    }
    await writeFile(marker, JSON.stringify({ bankId: config.bankId }, null, 2) + '\n');
  }

  const brand = { id: config.bankId, name: config.bankName, wordmark: config.bankName.toUpperCase(),
    ifsc: config.ifsc, color: config.brandColor, theme: 'nexus' };
  await writeFile(join(target, 'src/bank-config.js'), 'export default ' + JSON.stringify(brand, null, 2) + ';\n');
  await writeFile(join(target, 'src/cloudflare-config.js'), 'export default ' + JSON.stringify(workerUrl) + ';\n');
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const name = config.bankName.replace(/[&<>"]/g, char => entities[char] ?? char);
  const path = join(target, 'index.html');
  const html = await readFile(path, 'utf8');
  const branded = html.replace(/<title>[^<]*<\/title>/i, () => '<title>' + name + ' | Account portal</title>')
    .replace(/(<meta name="description" content=")[^"]*(")/i, (_, start, end) => start + name + ' account portal' + end);
  if (branded !== html) await writeFile(path, branded);

}

function configurePages(repo, cwd) {
  const endpoint = 'repos/' + repo + '/pages';
  const pages = ghJson(['api', endpoint], cwd);
  if (!pages) gh(['api', '--method', 'POST', endpoint, '-f', 'build_type=workflow', '--silent'], cwd);
  else if (pages.build_type !== 'workflow') gh(['api', '--method', 'PUT', endpoint, '-f', 'build_type=workflow', '--silent'], cwd);
}

async function waitForPages(repo, directory) {
  const sha = output('git', ['rev-parse', 'HEAD'], { cwd: directory });
  const runs = 'repos/' + repo + '/actions/workflows/pages.yml/runs?head_sha=' + sha + '&per_page=1';
  for (let attempt = 0; attempt < 14; attempt++) {
    const run = ghJson(['api', runs], directory)?.workflow_runs?.[0];
    if (run) {
      gh(['run', 'watch', String(run.id), '--repo', repo, '--exit-status'], directory);
      return;
    }
    if (attempt === 6) gh(['workflow', 'run', 'pages.yml', '--repo', repo, '--ref', 'main'], directory);
    await sleep(5000);
  }
  throw new Error('The Pages run is not visible yet. Check the workflow link printed above.');
}

export async function portal(config, { publish, wait, workspace }) {
  const repo = config.githubOwner + '/' + config.githubRepo;
  const directory = join(resolve(workspace), config.githubRepo);
  await mkdir(resolve(workspace), { recursive: true });
  if (publish) {
    gh(['auth', 'status'], resolve(workspace));
    const endpoint = 'repos/' + repo;
    if (!ghJson(['api', endpoint], resolve(workspace))) {
      gh(['repo', 'create', repo, '--public', '--add-readme'], resolve(workspace));
      const created = ghJson(['api', endpoint], resolve(workspace));
      if (created?.default_branch && created.default_branch !== 'main') {
        gh(['api', '--method', 'POST', endpoint + '/branches/' + encodeURIComponent(created.default_branch) + '/rename',
          '-f', 'new_name=main', '--silent'], resolve(workspace));
      }
    }
    if (!await exists(directory)) gh(['repo', 'clone', repo, directory], resolve(workspace));
    const remote = output('git', ['remote', 'get-url', 'origin'], { cwd: directory });
    const remoteRepo = remote.replace(/^https:\/\/github\.com\/|^git@github\.com:/i, '').replace(/\.git\/?$/i, '');
    if (remoteRepo.toLowerCase() !== repo.toLowerCase()) throw new Error('The local checkout points to another repository.');
    if (output('git', ['branch', '--show-current'], { cwd: directory }) !== 'main') throw new Error('Check out main before publishing.');
    if (output('git', ['status', '--porcelain'], { cwd: directory })) throw new Error('Commit or stash the changes in ' + directory + ' before publishing.');
    cli('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: directory });
  } else {
    await mkdir(directory, { recursive: true });
  }

  await assemblePortal(directory, config);
  cli('npm', ['ci'], { cwd: directory });
  cli('npm', ['run', 'build'], { cwd: directory });

  if (publish) {
    cli('git', ['add', '.'], { cwd: directory });
    cli('git', ['diff', '--cached', '--check'], { cwd: directory });
    if (output('git', ['diff', '--cached', '--name-only'], { cwd: directory })) {
      cli('git', ['commit', '-m', 'Configure SharedBank portal for ' + config.bankId], { cwd: directory });
    }
    configurePages(repo, directory);
    cli('git', ['push', 'origin', 'main'], { cwd: directory });
    console.log('GitHub Actions: https://github.com/' + repo + '/actions/workflows/pages.yml');
    if (wait) await waitForPages(repo, directory);
  }
  console.log('Bank portal: ' + portalOf(config) + '\nLocal source: ' + directory);
}

export async function verify(config) {
  const origin = originOf(config);
  const response = await fetch(workerUrl + '/api/v1/directory/ifsc/' + config.ifsc, { signal: AbortSignal.timeout(12_000) });
  const bank = await response.json();
  if (!response.ok || bank.bankId !== config.bankId || bank.status !== 'ACTIVE' || bank.portalUrl !== portalOf(config)) {
    throw new Error('SharedDB routing did not return the expected ACTIVE bank and portal URL.');
  }
  if (!await allowed(origin)) throw new Error('The Worker does not allow ' + origin + '.');
  const page = await fetch(portalOf(config), { signal: AbortSignal.timeout(12_000) });
  if (!page.ok) throw new Error('The site is not published yet. Check the Pages workflow.');
  const html = await page.text();
  const script = html.match(/<script[^>]+src="([^"]+\.js)"[^>]*>/i)?.[1];
  if (!script) throw new Error('The published page has no compiled JavaScript entry.');
  const bundle = await fetch(new URL(script, page.url), { signal: AbortSignal.timeout(12_000) });
  const text = await bundle.text();
  if (!bundle.ok || !text.includes(workerUrl) || !text.includes(config.bankId)) {
    throw new Error('The published bundle does not contain the expected bank ID and Worker URL.');
  }
  console.log('Verified SharedDB routing, Cloudflare CORS, and the published ' + basename(config.githubRepo) + ' build.');
  console.log('Open ' + portalOf(config) + ' and sign in as the configured test customer.');
}
