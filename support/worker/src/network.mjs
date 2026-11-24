import { ApiError, NeedsReview } from './errors.mjs';
import { documentPath, isConflict } from './firestore.mjs';
import { digest } from './google.mjs';
import { accountPath, credit, finishReservation, ledgerAccount, ownedActiveAccount,
  positiveInteger, publicAccount, reserve, settleInternal } from './bank-ledger.mjs';

export const bankIdPattern = /^P\d{3}$/;
export const ifscPattern = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const validProject = value => typeof value === 'string' && projectPattern.test(value);
export const accountIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
export const accountNumberPattern = /^[A-Za-z0-9-]{4,40}$/;
export const engine = 'X42_CLOUDFLARE_V1';
const terminal = new Set(['COMPLETED', 'REJECTED', 'MANUAL_REVIEW']);
const jobPath = id => documentPath('worker_transfer_jobs', id);
const switchPath = id => documentPath('switch_transfers', id);
const activityParent = owner => documentPath('worker_activity', owner);
const activityPath = (owner, id) => documentPath('worker_activity', owner, 'entries', id);
const ownerKey = (bankId, uid) => digest(JSON.stringify([bankId, uid]));

function publicBank(snapshot) {
  const { bankId, bankName, ifsc, status, x42 } = snapshot.data;
  const ready = status === 'ACTIVE' && x42?.enabled === true;
  return { bankId, bankName: bankName || bankId, ifsc, status: ready ? 'ACTIVE' : 'INACTIVE',
    ...(x42?.portalUrl && { portalUrl: x42.portalUrl }) };
}

function publicTransfer(job) {
  return {
    transferId: job.transferId, type: job.type, sourceBankId: job.sourceBankId,
    destinationBankId: job.destinationBankId, amountMinor: job.amountMinor,
    currency: 'INR', status: job.status, phase: job.phase, createdAt: job.createdAt,
    updatedAt: job.updatedAt, ...(job.completedAt && { completedAt: job.completedAt }),
    ...(job.code && { code: job.code }),
  };
}

function change(job, phase, status = 'PROCESSING', code = null) {
  const updatedAt = new Date();
  return { ...job, status, phase, code, updatedAt, retryCount: 0,
    nextAttemptAt: updatedAt, ...(status === 'COMPLETED' && { completedAt: updatedAt }) };
}

export function createNetwork(db, centralProject) {
  const central = db(centralProject);

  async function getBank(bankId) {
    if (!bankIdPattern.test(bankId)) throw new ApiError(404, 'BANK_NOT_FOUND', 'Unknown bank.');
    const snapshot = await central.get(documentPath('banks', bankId));
    if (!snapshot || snapshot.data.bankId !== bankId) throw new ApiError(404, 'BANK_NOT_FOUND', 'Unknown bank.');
    return snapshot;
  }

  async function bankConfig(bankId) {
    const snapshot = await getBank(bankId);
    const record = snapshot.data;
    const config = record.x42;
    if (record.status !== 'ACTIVE' || config?.enabled !== true ||
      !validProject(config.projectId) || config.projectId === centralProject ||
      !ifscPattern.test(record.ifsc) || typeof config.firebaseWebApiKey !== 'string' || !config.firebaseWebApiKey) {
      throw new ApiError(409, 'BANK_NOT_READY', 'The bank is not enabled for transfers yet.');
    }
    return { ...publicBank(snapshot), projectId: config.projectId, firebaseWebApiKey: config.firebaseWebApiKey };
  }

  async function operatorConfig() {
    const record = (await central.get('worker_settings/operator_auth'))?.data;
    if (!record?.firebaseWebApiKey || !Array.isArray(record.allowedUids)) {
      throw new ApiError(503, 'OPERATOR_NOT_CONFIGURED', 'Central operator sign-in is not configured.');
    }
    return { projectId: centralProject, firebaseWebApiKey: record.firebaseWebApiKey, allowedUids: record.allowedUids };
  }

  async function lookupIfsc(ifsc) {
    if (!ifscPattern.test(ifsc)) throw new ApiError(400, 'INVALID_IFSC', 'Enter a valid 11-character IFSC.');
    const target = await central.get(documentPath('ifsc_registry', ifsc));
    if (!target) throw new ApiError(404, 'IFSC_NOT_FOUND', 'This IFSC is absent from the directory.');
    const bank = await getBank(target.data.bankId);
    if (bank.data.ifsc !== ifsc) throw new ApiError(409, 'DIRECTORY_MISMATCH', 'The bank directory entry needs review.');
    return publicBank(bank);
  }

  async function listBanks() {
    const banks = await central.query('banks', { limit: 100 });
    return banks.filter(bank => bankIdPattern.test(bank.data.bankId)).map(publicBank);
  }

  async function accountDashboard(config, uid) {
    const accountDb = db(config.projectId);
    const owner = await ownerKey(config.bankId, uid);
    const [accounts, activity] = await Promise.all([
      accountDb.query('accounts', { where: ['customerUid', 'EQUAL', uid], limit: 50 }),
      central.query('entries', { parent: activityParent(owner), orderBy: ['createdAt', 'DESCENDING'] }),
    ]);
    return { bank: { bankId: config.bankId, bankName: config.bankName, ifsc: config.ifsc },
      accounts: accounts.map(publicAccount).filter(Boolean), transfers: activity.map(entry => entry.data) };
  }

  async function operatorActivity() {
    const [interbank, internal] = await Promise.all([
      central.query('switch_transfers', { orderBy: ['createdAt', 'DESCENDING'], limit: 50 }),
      central.query('internal_transfer_events', { orderBy: ['createdAt', 'DESCENDING'], limit: 50 }),
    ]);
    return [...interbank, ...internal].map(snapshot => snapshot.data)
      .filter(record => typeof record.transferId === 'string')
      .map(record => publicTransfer({ ...record, type: record.type || 'INTERBANK', phase: record.phase || record.status,
        updatedAt: record.updatedAt || record.createdAt }))
      .sort((a, b) => (b.createdAt?.getTime?.() || 0) - (a.createdAt?.getTime?.() || 0)).slice(0, 50);
  }

  async function accept(config, uid, key, body) {
    if (!/^[A-Za-z0-9_.~-]{8,128}$/.test(key || '')) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key for this transfer.');
    }
    const fromAccountId = typeof body?.fromAccountId === 'string' ? body.fromAccountId.trim() : '';
    const destinationIfsc = typeof body?.destinationIfsc === 'string' ? body.destinationIfsc.trim().toUpperCase() : '';
    const destinationAccountNumber = typeof body?.destinationAccountNumber === 'string'
      ? body.destinationAccountNumber.trim() : '';
    const amountMinor = body?.amountMinor;
    if (!accountIdPattern.test(fromAccountId) || !ifscPattern.test(destinationIfsc) ||
        !accountNumberPattern.test(destinationAccountNumber) || !positiveInteger(amountMinor) || body.currency !== 'INR') {
      throw new ApiError(400, 'INVALID_TRANSFER', 'Enter a source account, valid destination details, and a positive INR amount.');
    }

    const owner = await ownerKey(config.bankId, uid);
    const [idHash, requestHash] = await Promise.all([
      digest(JSON.stringify([owner, key])),
      digest(JSON.stringify([fromAccountId, destinationIfsc, destinationAccountNumber, amountMinor, 'INR'])),
    ]);
    const transferId = config.bankId + '-CF-' + idHash.slice(0, 32);
    const path = jobPath(transferId);
    const replay = snapshot => {
      if (snapshot.data.fromOwner !== owner || snapshot.data.requestHash !== requestHash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request ID was already used with different transfer details.');
      }
      return snapshot.data;
    };
    const existing = await central.get(path);
    if (existing) return replay(existing);

    const route = await lookupIfsc(destinationIfsc);
    const sameBank = route.bankId === config.bankId;
    const target = sameBank ? config : await bankConfig(route.bankId);
    const [source, destinations] = await Promise.all([
      db(config.projectId).get(accountPath(fromAccountId)),
      db(target.projectId).query('accounts', { where: ['accountNumber', 'EQUAL', destinationAccountNumber], limit: 2 }),
    ]);
    if (!ownedActiveAccount(source, uid)) {
      throw new ApiError(404, 'SOURCE_ACCOUNT_UNAVAILABLE', 'Select an active demo account owned by this session.');
    }
    const recipient = destinations.length === 1 ? ledgerAccount(destinations[0]) : null;
    if (recipient?.status !== 'ACTIVE' || typeof recipient.customerUid !== 'string' || !recipient.customerUid) {
      throw new ApiError(422, 'DESTINATION_ACCOUNT_UNAVAILABLE', 'The destination account is unavailable for this transfer.');
    }
    const toAccountId = destinations[0].path.split('/').at(-1);
    if (!accountIdPattern.test(toAccountId) || (sameBank && fromAccountId === toAccountId)) {
      throw new ApiError(422, 'INVALID_DESTINATION', 'Choose a different destination account.');
    }
    const now = new Date();
    const job = {
      engine, transferId, requestHash, type: sameBank ? 'INTERNAL' : 'INTERBANK',
      sourceBankId: config.bankId, destinationBankId: target.bankId,
      fromProjectId: config.projectId, toProjectId: target.projectId,
      fromAccountId, toAccountId, fromUid: uid, toUid: recipient.customerUid,
      fromOwner: owner, toOwner: await ownerKey(target.bankId, recipient.customerUid),
      amountMinor, currency: 'INR', status: 'PENDING', phase: sameBank ? 'INTERNAL' : 'RESERVE',
      createdAt: now, updatedAt: now, nextAttemptAt: now, retryCount: 0, code: null,
    };
    const writes = [central.create(path, job),
      central.create(activityPath(job.fromOwner, transferId), { ...publicTransfer(job), direction: 'DEBIT' })];
    if (!sameBank) writes.push(central.create(switchPath(transferId), { ...publicTransfer(job), engine, destinationIfsc }));
    try {
      await central.commit(writes);
    } catch (error) {
      if (!isConflict(error)) throw error;
      const saved = await central.get(path);
      if (!saved) throw error;
      return replay(saved);
    }
    return job;
  }

  async function publish(snapshot, next) {
    const done = terminal.has(next.status);
    const { status, phase, code = null, retryCount, updatedAt, nextAttemptAt } = next;
    const updates = { status, phase, code, retryCount, updatedAt, ...(!done && { nextAttemptAt }),
      ...(next.completedAt && { completedAt: next.completedAt }) };
    const visible = { status, phase, code, updatedAt, ...(next.completedAt && { completedAt: next.completedAt }) };
    const writes = [
      central.patch(snapshot, updates, done ? ['nextAttemptAt'] : []),
      central.patchExisting(activityPath(next.fromOwner, next.transferId), visible),
    ];
    if (next.type === 'INTERBANK') writes.push(central.patchExisting(switchPath(next.transferId), visible));
    if (next.status === 'COMPLETED') {
      if (next.fromOwner !== next.toOwner) {
        writes.push(central.create(activityPath(next.toOwner, next.transferId), { ...publicTransfer(next), direction: 'CREDIT' }));
      }
      if (next.type === 'INTERNAL') writes.push(central.create(
        documentPath('internal_transfer_events', next.sourceBankId + '_' + next.transferId), { ...publicTransfer(next), engine },
      ));
    }
    await central.commit(writes);
  }

  async function applyStep(job) {
    const source = db(job.fromProjectId);
    switch (job.phase) {
      case 'RESERVE': {
        const result = await reserve(source, job);
        return result.status === 'REJECTED'
          ? change(job, 'RESERVE', 'REJECTED', result.code) : change(job, 'CREDIT');
      }
      case 'CREDIT': {
        const result = await credit(db(job.toProjectId), job);
        return result.status === 'REJECTED'
          ? change(job, 'RELEASE', 'PROCESSING', result.code) : change(job, 'COMMIT_DEBIT');
      }
      case 'COMMIT_DEBIT':
        await finishReservation(source, job, false);
        return change(job, 'COMMIT_DEBIT', 'COMPLETED');
      case 'RELEASE':
        await finishReservation(source, job, true);
        return change(job, 'RELEASE', 'REJECTED', job.code || 'DESTINATION_ACCOUNT_UNAVAILABLE');
      case 'INTERNAL': {
        const result = await settleInternal(source, job);
        return result.status === 'REJECTED' ? change(job, 'INTERNAL', 'REJECTED', result.code)
          : { ...change(job, 'INTERNAL', 'COMPLETED'), completedAt: result.completedAt };
      }
      default: throw new NeedsReview('UNKNOWN_PHASE');
    }
  }

  async function process(transferId) {
    for (let step = 0; step < 4; step++) {
      const snapshot = await central.get(jobPath(transferId));
      const job = snapshot?.data;
      if (!job || job.engine !== engine || terminal.has(job.status) || job.nextAttemptAt > new Date()) return;
      let next;
      try {
        next = await applyStep(job);
      } catch (error) {
        if (error instanceof NeedsReview) {
          next = change(job, job.phase, 'MANUAL_REVIEW', error.code);
        } else {
          const retryCount = (job.retryCount || 0) + 1;
          const forReview = retryCount >= 10;
          next = { ...job, retryCount, status: forReview ? 'MANUAL_REVIEW' : job.status,
            code: forReview ? 'RETRY_LIMIT' : job.code, updatedAt: new Date(),
            nextAttemptAt: new Date(Date.now() + Math.min(10 * 60_000, 10_000 * 2 ** (retryCount - 1))) };
          console.warn('X42 leg retry', job.transferId, job.phase, error.name, error.code || error.status || '');
        }
      }
      try { await publish(snapshot, next); }
      catch (error) { if (isConflict(error)) return; throw error; }
      if (terminal.has(next.status) || next.retryCount) return;
    }
  }

  async function recover() {
    const due = await central.query('worker_transfer_jobs', {
      where: ['nextAttemptAt', 'LESS_THAN_OR_EQUAL', new Date()], orderBy: ['nextAttemptAt', 'ASCENDING'], limit: 1,
    });
    if (due.length) await process(due[0].data.transferId);
  }

  async function requeue(transferId) {
    if (!/^P\d{3}-CF-[a-f0-9]{32}$/.test(transferId || '')) throw new Error('Enter a valid Worker transfer ID.');
    const snapshot = await central.get(jobPath(transferId));
    if (snapshot?.data.engine !== engine || snapshot.data.status !== 'MANUAL_REVIEW') {
      throw new Error('Only a Worker transfer in MANUAL_REVIEW can be requeued.');
    }
    await publish(snapshot, change(snapshot.data, snapshot.data.phase));
  }

  return { bankConfig, operatorConfig, listBanks, lookupIfsc, accountDashboard, operatorActivity, accept, process, recover, requeue };
}

export { publicTransfer };
