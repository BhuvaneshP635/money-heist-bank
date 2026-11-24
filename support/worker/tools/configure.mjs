import { run } from '../../../lib/common.mjs';
import { Firestore, documentPath } from '../src/firestore.mjs';
import { createNetwork, accountIdPattern, accountNumberPattern, bankIdPattern, ifscPattern, validProject } from '../src/network.mjs';

const centralProject = process.env.CENTRAL_PROJECT_ID || 'sharedbank-connect';
const usage = `Usage (run with authorized gcloud credentials)

  node tools/configure.mjs bank BANK_ID PROJECT_ID IFSC WEB_API_KEY "BANK NAME" [PORTAL_URL]
  node tools/configure.mjs account BANK_ID BANK_PROJECT_ID ACCOUNT_ID ACCOUNT_NUMBER FIREBASE_UID INITIAL_PAISE
  node tools/configure.mjs operator WEB_API_KEY FIREBASE_UID
  node tools/configure.mjs requeue TRANSFER_ID

The account command preserves existing balances and can attach a Firebase user to a synthetic seed account.`;

async function onboard(central, [bankId, projectId, ifsc, firebaseWebApiKey, name, portalUrl]) {
  if (!bankIdPattern.test(bankId) || !validProject(projectId) || projectId === centralProject ||
    !ifscPattern.test(ifsc) || !keyLooksValid(firebaseWebApiKey) || !name?.trim()) throw new Error(usage);
  if (portalUrl) {
    const url = new URL(portalUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use the public HTTPS bank page URL.');
  }
  const [bankPath, ifscPath, projectPath] = [
    documentPath('banks', bankId), documentPath('ifsc_registry', ifsc), documentPath('worker_project_registry', projectId),
  ];
  const [bank, routing, project] = await Promise.all([central.get(bankPath), central.get(ifscPath), central.get(projectPath)]);
  if ((bank && bank.data.bankId !== bankId) || (bank?.data.ifsc && bank.data.ifsc !== ifsc) ||
    (routing && routing.data.bankId !== bankId) || (project && project.data.bankId !== bankId) ||
    (bank?.data.x42?.projectId && bank.data.x42.projectId !== projectId)) {
    throw new Error('The existing bank, IFSC, or private project mapping conflicts. Review the registry before changing it.');
  }
  const now = new Date();
  const publicUrl = portalUrl || bank?.data.x42?.portalUrl;
  const x42 = { projectId, firebaseWebApiKey, enabled: true, ...(publicUrl && { portalUrl: publicUrl }) };
  const writes = [
    central.set(bankPath, bank, { ...(bank ? {} : { createdAt: now }), bankId, bankName: name.trim(), ifsc,
      status: 'ACTIVE', environment: 'TEST', x42, updatedAt: now }),
    central.set(ifscPath, routing, { bankId, ...(routing ? {} : { createdAt: now }) }),
    central.set(projectPath, project, { bankId, ...(project ? {} : { createdAt: now }) }),
  ];
  await central.commit(writes);
  console.log('Enabled ' + bankId + ' (' + ifsc + ') for project ' + projectId + '.');
}

function keyLooksValid(key) { return /^[A-Za-z0-9_\-]{15,150}$/.test(key || ''); }
function uidLooksValid(uid) { return typeof uid === 'string' && /^[^\/\u0000-\u001f\s]{1,128}$/.test(uid); }

async function account(db, [bankId, projectId, id, number, uid, amount]) {
  if (!bankIdPattern.test(bankId) || !validProject(projectId) || projectId === centralProject ||
    !accountIdPattern.test(id) || !accountNumberPattern.test(number) ||
    !uidLooksValid(uid) || !/^\d+$/.test(amount || '') || !Number.isSafeInteger(Number(amount))) throw new Error(usage);
  const bank = db(projectId), path = documentPath('accounts', id);
  const [current, matches] = await Promise.all([
    bank.get(path), bank.query('accounts', { where: ['accountNumber', 'EQUAL', number], limit: 2 }),
  ]);
  if (matches.some(snapshot => snapshot.path !== path)) throw new Error('An account already uses this account number.');
  const now = new Date();
  if (current) {
    const value = current.data;
    const placeholder = /^(?:lyra_)?demo_uid_[A-Za-z0-9_-]+$/.test(value.customerUid || '');
    if (value.isSynthetic !== true || value.currency !== 'INR' || value.accountNumber !== number ||
      (value.customerUid !== uid && (!placeholder || value.heldMinor !== 0))) {
      throw new Error('Refusing to change an unrelated or reserved account. Check the account number and owner.');
    }
    if (value.customerUid === uid) {
      console.log(id + ' is already attached. Balance preserved.');
      return;
    }
    await bank.commit([bank.patch(current, { customerUid: uid, updatedAt: now })]);
    console.log('Attached ' + id + ' to its Firebase user. Existing balance preserved.');
    return;
  }

  const startingBalance = Number(amount);
  const writes = [bank.create(path, { accountId: id, customerUid: uid, accountNumber: number,
    isSynthetic: true, currency: 'INR', status: 'ACTIVE', postedBalanceMinor: startingBalance,
    heldMinor: 0, createdAt: now, updatedAt: now })];
  if (startingBalance) {
    const entryId = bankId + '-CF-SEED-' + id + '_CREDIT';
    writes.push(bank.create(documentPath('ledger_entries', entryId), { entryId, transferId: bankId + '-CF-SEED-' + id,
      accountId: id, amountMinor: startingBalance, postedAt: now, direction: 'CREDIT', currency: 'INR', entryType: 'DEMO_SEED' }));
  }
  await bank.commit(writes);
  console.log('Created synthetic account ' + id + '.');
}

async function operator(central, [firebaseWebApiKey, uid]) {
  if (!keyLooksValid(firebaseWebApiKey) || !uidLooksValid(uid)) throw new Error(usage);
  const path = 'worker_settings/operator_auth';
  const previous = await central.get(path);
  const allowedUids = [...new Set([...(previous?.data.allowedUids || []), uid])];
  await central.commit([central.set(path, previous, { firebaseWebApiKey, allowedUids, updatedAt: new Date() })]);
  console.log('Central operator account configured.');
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || !command) console.log(usage);
  else {
    if (!['bank', 'account', 'operator', 'requeue'].includes(command) || !validProject(centralProject)) throw new Error(usage);
    const value = run('gcloud', ['auth', 'print-access-token', '--quiet'], {
      encoding: 'utf8', timeout: 30_000,
    }).trim();
    const db = projectId => new Firestore({ projectId, token: async () => value });
    const central = db(centralProject);
    if (command === 'bank') await onboard(central, args);
    if (command === 'account') await account(db, args);
    if (command === 'operator') await operator(central, args);
    if (command === 'requeue') {
      await createNetwork(db, centralProject).requeue(args[0]);
      console.log('The existing transfer has been queued at the recorded phase.');
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
