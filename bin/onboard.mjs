#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../lib/common.mjs';
import { prepare, register } from '../lib/google.mjs';
import { cloudflare, portal, verify } from '../lib/deploy.mjs';

const usage = `Usage: node bin/onboard.mjs STAGE CONFIG_FILE [OPTIONS]

  prepare    [--create-project]
  register   [--registration FILE]
  cloudflare --worker-dir DIRECTORY [--deploy]
  portal     [--workspace DIRECTORY] [--publish [--wait]]
  verify

Cloud Shell: prepare and register. Git Bash: cloudflare, portal and verify.`;

const optionsFor = {
  prepare: { '--create-project': false },
  register: { '--registration': true },
  cloudflare: { '--worker-dir': true, '--deploy': false },
  portal: { '--workspace': true, '--publish': false, '--wait': false },
  verify: {},
};

try {
  const [stage, file, ...args] = process.argv.slice(2);
  if (stage === '--help' || stage === undefined) { console.log(usage); process.exit(0); }
  if (!Object.hasOwn(optionsFor, stage) || !file || file.startsWith('--')) throw new Error(usage);
  const flags = {};
  while (args.length) {
    const name = args.shift();
    if (!Object.hasOwn(optionsFor[stage], name) || Object.hasOwn(flags, name)) throw new Error('Invalid option: ' + name);
    flags[name] = optionsFor[stage][name] ? args.shift() : true;
    if (!flags[name] || String(flags[name]).startsWith('--')) throw new Error('Provide a value for ' + name);
  }
  const config = await loadConfig(file);
  switch (stage) {
    case 'prepare': await prepare(config, { createProject: !!flags['--create-project'] }); break;
    case 'register': {
      const file = flags['--registration'] || 'x42-registration-' + config.bankId + '.json';
      const registration = await readFile(file, 'utf8').catch(error => {
        if (error.code === 'ENOENT') {
          throw new Error('Missing ' + file + '. Ask the bank owner for the registration file produced by the prepare stage.');
        }
        throw error;
      });
      register(config, JSON.parse(registration));
      break;
    }
    case 'cloudflare': {
      if (!flags['--worker-dir']) throw new Error('Pass --worker-dir for the current SharedDB Worker checkout.');
      await cloudflare(config, flags['--worker-dir'], !!flags['--deploy']); break;
    }
    case 'portal': {
      if (flags['--wait'] && !flags['--publish']) throw new Error('--wait requires --publish.');
      await portal(config, { publish: !!flags['--publish'], wait: !!flags['--wait'],
        workspace: flags['--workspace'] || 'x42-portals' });
      break;
    }
    case 'verify': await verify(config); break;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
