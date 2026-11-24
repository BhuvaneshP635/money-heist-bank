import { writeFile } from 'node:fs/promises';
import { central, cli, configureBank, gcloud, googleToken, originOf, output, portalOf, request, sleep, workerIdentity } from './common.mjs';

const management = 'https://firebase.googleapis.com/v1beta1';
const identity = 'https://identitytoolkit.googleapis.com';

async function operationResult(operation, google) {
  if (operation?.done !== true && !operation?.name) throw new Error('Firebase returned no operation ID.');
  for (let i = 0; !operation.done && i < 45; i++) {
    await sleep(2500);
    operation = await google(management + '/' + operation.name);
  }
  if (!operation.done) throw new Error('Firebase provisioning is still running. Retry this stage shortly.');
  if (operation.error) throw new Error(operation.error.message || 'Firebase provisioning failed.');
  return operation.response;
}

async function missing(action, known = '') {
  try { return await action(); }
  catch (error) {
    if (error.status === 404 || (known && error.status === 400 && error.message.includes(known))) return null;
    throw error;
  }
}

async function firebaseWebKey(config, google) {
  const { firebaseProjectId: id, bankId } = config;
  const parent = management + '/projects/' + id;
  const displayName = 'SharedBank Portal ' + bankId;
  let appId = config.firebaseWebAppId;
  if (!appId) {
    const matches = [];
    let page;
    do {
      const result = await google(parent + '/webApps' + (page ? '?pageToken=' + encodeURIComponent(page) : ''));
      matches.push(...(result.apps || []).filter(app => app.displayName === displayName));
      page = result.nextPageToken;
    } while (page);
    if (matches.length > 1) throw new Error('Multiple portal apps share a name. Set firebaseWebAppId in bank.json.');
    appId = matches[0]?.appId;
  }
  if (!appId) {
    const operation = await google(parent + '/webApps', { method: 'POST', body: { displayName } });
    appId = (await operationResult(operation, google))?.appId;
  }
  if (!appId) throw new Error('The Web app ID was not returned by Firebase.');
  const app = await google(parent + '/webApps/' + encodeURIComponent(appId) + '/config');
  if (app.projectId !== id || !/^[A-Za-z0-9_-]{15,150}$/.test(app.apiKey || '')) {
    throw new Error('The Firebase Web app config does not match the bank project.');
  }
  return app.apiKey;
}

async function checkSignIn(id, google) {
  const url = identity + '/admin/v2/projects/' + id + '/config';
  const config = await missing(() => google(url), 'CONFIGURATION_NOT_FOUND');
  const email = config?.signIn?.email;
  if (email?.enabled !== true || email.passwordRequired === false) {
    throw new Error('Enable Email/Password for this bank in Firebase Authentication, then rerun prepare.\n' +
      'Open https://console.firebase.google.com/project/' + id + '/authentication/providers\n' +
      'Choose Get started if shown, then Sign-in method > Email/Password > Enable > Save.');
  }
}

async function findOrCreateUser(config, google) {
  const base = identity + '/v1/projects/' + config.firebaseProjectId + '/accounts';
  const existing = await missing(() => google(base + ':lookup', { method: 'POST', body: { email: [config.testUserEmail] } }), 'USER_NOT_FOUND');
  const user = existing?.users?.[0];
  if (user) {
    if (user.disabled || !user.localId) throw new Error('The existing Firebase test user is disabled or has no UID.');
    console.log('Reusing the existing Firebase test user.');
    return user.localId;
  }

  let password = cli('bash', ['-c', String.raw`IFS= read -r -s -p 'Choose a password for the new test user: ' pw || exit 1; printf '\n' >&2; printf '%s' "$pw"`],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (password.length < 6) throw new Error('Use at least six characters for the test password.');
  try {
    const created = await google(base, { method: 'POST', body: { email: config.testUserEmail, password, returnSecureToken: false } });
    if (!created.localId) throw new Error('Firebase did not return a UID.');
    return created.localId;
  } finally {
    password = '';
  }
}

function ensureProject(config, createProject) {
  const { firebaseProjectId: id, bankName } = config;
  try { output('gcloud', ['projects', 'describe', id, '--format=value(projectId)']); }
  catch (error) {
    if (!createProject) throw new Error('Cannot access project ' + id + '. Select its Google account, or pass --create-project for a new project.');
    const displayName = bankName.replace(/[^a-z0-9'! -]/gi, ' ').slice(0, 30).replace(/[^a-z0-9]+$/i, '');
    gcloud(['projects', 'create', id, '--name=' + (displayName.length >= 4 ? displayName : 'SharedBank ' + config.bankId)]);
  }
  gcloud(['services', 'enable', 'firebase.googleapis.com', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com', '--project=' + id]);
}

function ensureDatabase(config) {
  const { firebaseProjectId: id, firestoreLocation } = config;
  const list = JSON.parse(output('gcloud', ['firestore', 'databases', 'list', '--project=' + id, '--format=json']));
  const db = list.find(row => row.name?.endsWith('/databases/(default)'));
  if (!db) gcloud(['firestore', 'databases', 'create', '--database=(default)', '--location=' + firestoreLocation,
    '--type=firestore-native', '--project=' + id]);
  else if (db.type !== 'FIRESTORE_NATIVE') throw new Error('The default database must use Firestore Native mode.');
  else console.log('Reusing the default Firestore database in ' + db.locationId + '.');
}

export async function prepare(config, { createProject, handoff = true }) {
  const id = config.firebaseProjectId;
  ensureProject(config, createProject);
  const token = googleToken();
  const google = (url, options) => request(url, { token, project: id, ...options });
  const name = management + '/projects/' + id;
  if (!await missing(() => google(name))) {
    await operationResult(await google(name + ':addFirebase', { method: 'POST', body: {} }), google);
  }
  ensureDatabase(config);
  await checkSignIn(id, google);
  const key = await firebaseWebKey(config, google);
  const uid = await findOrCreateUser(config, google);

  configureBank(['account', config.bankId, id, config.accountId, config.accountNumber, uid,
    String(config.openingBalancePaise)]);
  gcloud(['projects', 'add-iam-policy-binding', id, '--member=serviceAccount:' + workerIdentity,
    '--role=roles/datastore.user', '--condition=None', '--quiet', '--format=none']);

  const file = 'x42-registration-' + config.bankId + '.json';
  const registration = { bankId: config.bankId, firebaseProjectId: id, ifsc: config.ifsc, bankName: config.bankName,
    origin: originOf(config), portalUrl: portalOf(config), firebaseWebApiKey: key };
  if (handoff) {
    await writeFile(file, JSON.stringify(registration, null, 2) + '\n', { mode: 0o600 });
    console.log('Bank prepared. Hand ' + file + ' to the SharedDB project administrator.');
    console.log('Test account number: ' + config.accountNumber + '\nIFSC: ' + config.ifsc);
  }
  return registration;
}

export function register(config, registration) {
  for (const key of ['bankId', 'firebaseProjectId', 'ifsc', 'bankName']) {
    if (config[key] !== registration[key]) throw new Error('Registration does not match bank.json: ' + key);
  }
  if (registration.origin !== originOf(config) || registration.portalUrl !== portalOf(config)) {
    throw new Error('The portal URL in the registration differs from bank.json.');
  }
  if (!/^[A-Za-z0-9_-]{15,150}$/.test(registration.firebaseWebApiKey || '')) throw new Error('Registration has no valid Firebase Web API key.');
  configureBank(['bank', config.bankId, config.firebaseProjectId, config.ifsc, registration.firebaseWebApiKey,
    config.bankName, portalOf(config)]);
  console.log('Registered in ' + central + '.');
}
