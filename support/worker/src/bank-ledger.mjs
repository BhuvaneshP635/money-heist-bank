import { NeedsReview } from './errors.mjs';
import { documentPath, isConflict } from './firestore.mjs';

export const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
export const balanceInteger = value => Number.isSafeInteger(value) && value >= 0;
export const accountPath = id => documentPath('accounts', id);

export function ledgerAccount(snapshot) {
  const value = snapshot?.data;
  return value?.isSynthetic === true && value.currency === 'INR' &&
    balanceInteger(value.postedBalanceMinor) && balanceInteger(value.heldMinor) &&
    value.heldMinor <= value.postedBalanceMinor ? value : null;
}

export function ownedActiveAccount(snapshot, uid) {
  const account = ledgerAccount(snapshot);
  return account?.status === 'ACTIVE' && account.customerUid === uid ? account : null;
}

export function publicAccount(snapshot) {
  const account = ledgerAccount(snapshot);
  if (!account) return null;
  return { accountId: snapshot.path.split('/').at(-1), accountNumber: account.accountNumber,
    label: account.label || 'Savings account', status: account.status,
    postedBalanceMinor: account.postedBalanceMinor, heldMinor: account.heldMinor,
    availableMinor: account.postedBalanceMinor - account.heldMinor, currency: 'INR' };
}

async function retryConflict(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (!isConflict(error) || attempt >= 2) throw error; }
  }
}

function usageFor(job) {
  const dateIST = new Date(job.createdAt.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const id = job.fromAccountId + '_' + dateIST;
  return { dateIST, path: documentPath('daily_usage', id), id };
}

async function funding(db, job) {
  const usage = usageFor(job);
  const [accountSnapshot, limits, usageSnapshot] = await Promise.all([
    db.get(accountPath(job.fromAccountId)),
    db.get(documentPath('transfer_limits', job.fromAccountId)),
    db.get(usage.path),
  ]);
  const source = ownedActiveAccount(accountSnapshot, job.fromUid);
  if (!source) return { code: 'SOURCE_ACCOUNT_UNAVAILABLE' };
  if (source.postedBalanceMinor - source.heldMinor < job.amountMinor) return { code: 'INSUFFICIENT_FUNDS' };
  const perTransfer = limits ? limits.data.perTransferMinor : 500_000;
  const daily = limits ? limits.data.dailyMinor : 700_000;
  const usedMinor = usageSnapshot ? usageSnapshot.data.usedMinor : 0;
  if (![perTransfer, daily, usedMinor].every(balanceInteger)) throw new NeedsReview('INVALID_LIMITS_OR_DAILY_USAGE');
  if (job.amountMinor > perTransfer || job.amountMinor > daily - usedMinor) return { code: 'LIMIT_EXCEEDED' };
  return { accountSnapshot, source, usage, usageSnapshot, usedMinor };
}

function fundingWrite(db, current, job, now) {
  return db.set(current.usage.path, current.usageSnapshot, {
    accountId: job.fromAccountId, dateIST: current.usage.dateIST,
    usedMinor: current.usedMinor + job.amountMinor, updatedAt: now,
  });
}

function journalEntry(db, job, accountId, direction, now) {
  const entryId = job.transferId + '_' + direction;
  return db.create(documentPath('ledger_entries', entryId), {
    entryId, transferId: job.transferId, accountId, direction, amountMinor: job.amountMinor,
    currency: 'INR', entryType: job.type, postedAt: now,
  });
}

function reservationMatches(snapshot, job) {
  return snapshot?.data?.transferId === job.transferId && snapshot.data.fromAccountId === job.fromAccountId &&
    snapshot.data.amountMinor === job.amountMinor;
}

export function reserve(db, job) {
  return retryConflict(async () => {
    const path = documentPath('reservations', job.transferId);
    const existing = await db.get(path);
    if (existing) {
      if (!reservationMatches(existing, job)) throw new NeedsReview('RESERVATION_CONFLICT');
      return existing.data;
    }
    const current = await funding(db, job);
    const now = new Date();
    const receipt = { transferId: job.transferId, reservationId: job.transferId, fromAccountId: job.fromAccountId,
      amountMinor: job.amountMinor, status: current.code ? 'REJECTED' : 'HELD',
      ...(current.code ? { code: current.code } : { dailyUsageId: current.usage.id }),
      createdAt: now, updatedAt: now };
    const writes = [db.create(path, receipt)];
    if (!current.code) writes.push(
      db.patch(current.accountSnapshot, { heldMinor: current.source.heldMinor + job.amountMinor, updatedAt: now }),
      fundingWrite(db, current, job, now),
    );
    await db.commit(writes);
    return receipt;
  });
}

export function credit(db, job) {
  return retryConflict(async () => {
    const path = documentPath('interbank_inbox', job.transferId);
    const existing = await db.get(path);
    if (existing) {
      if (existing.data.transferId !== job.transferId || existing.data.destinationAccountId !== job.toAccountId ||
          existing.data.amountMinor !== job.amountMinor) throw new NeedsReview('CREDIT_RECEIPT_CONFLICT');
      return existing.data;
    }
    const snapshot = await db.get(accountPath(job.toAccountId));
    const target = ownedActiveAccount(snapshot, job.toUid);
    const nextBalance = target && target.postedBalanceMinor + job.amountMinor;
    const code = !target ? 'DESTINATION_ACCOUNT_UNAVAILABLE' :
      !balanceInteger(nextBalance) ? 'DESTINATION_BALANCE_LIMIT' : null;
    const now = new Date();
    const receipt = { transferId: job.transferId, sourceBankId: job.sourceBankId,
      destinationAccountId: job.toAccountId, amountMinor: job.amountMinor, currency: 'INR',
      status: code ? 'REJECTED' : 'COMPLETED', ...(code && { code }), createdAt: now, updatedAt: now };
    const writes = [db.create(path, receipt)];
    if (!code) writes.push(
      db.patch(snapshot, { postedBalanceMinor: nextBalance, updatedAt: now }),
      journalEntry(db, job, job.toAccountId, 'CREDIT', now),
    );
    await db.commit(writes);
    return receipt;
  });
}

export function finishReservation(db, job, release) {
  return retryConflict(async () => {
    const path = documentPath('reservations', job.transferId);
    const [snapshot, receipt] = await Promise.all([db.get(accountPath(job.fromAccountId)), db.get(path)]);
    if (!reservationMatches(receipt, job)) throw new NeedsReview('RESERVATION_MISSING_OR_CONFLICT');
    const expected = release ? 'RELEASED' : 'COMMITTED';
    if (receipt.data.status === expected) return;
    const source = ledgerAccount(snapshot);
    if (receipt.data.status !== 'HELD' || !source || source.heldMinor < job.amountMinor) {
      throw new NeedsReview('HOLD_NOT_AVAILABLE');
    }
    const now = new Date();
    const writes = [
      db.patch(receipt, { status: expected, updatedAt: now }),
      db.patch(snapshot, { heldMinor: source.heldMinor - job.amountMinor, updatedAt: now,
        ...(!release && { postedBalanceMinor: source.postedBalanceMinor - job.amountMinor }) }),
    ];
    if (release) {
      const usage = await db.get(documentPath('daily_usage', receipt.data.dailyUsageId));
      if (!balanceInteger(usage?.data.usedMinor) || usage.data.usedMinor < job.amountMinor) {
        throw new NeedsReview('DAILY_USAGE_NOT_AVAILABLE_FOR_RELEASE');
      }
      writes.push(db.patch(usage, { usedMinor: usage.data.usedMinor - job.amountMinor, updatedAt: now }));
    } else {
      writes.push(journalEntry(db, job, job.fromAccountId, 'DEBIT', now),
        db.create(documentPath('transfers', job.transferId), {
          transferId: job.transferId, fromAccountId: job.fromAccountId, destinationBankId: job.destinationBankId,
          amountMinor: job.amountMinor, currency: 'INR', status: 'COMPLETED', type: job.type,
          requestedByUid: job.fromUid, createdAt: job.createdAt, completedAt: now,
        }));
    }
    await db.commit(writes);
  });
}

export function settleInternal(db, job) {
  return retryConflict(async () => {
    const path = documentPath('transfers', job.transferId);
    const existing = await db.get(path);
    if (existing) {
      if (existing.data.transferId !== job.transferId || existing.data.amountMinor !== job.amountMinor) {
        throw new NeedsReview('INTERNAL_RECEIPT_CONFLICT');
      }
      return existing.data;
    }
    const [current, targetSnapshot] = await Promise.all([
      funding(db, job), db.get(accountPath(job.toAccountId)),
    ]);
    const target = ownedActiveAccount(targetSnapshot, job.toUid);
    const nextBalance = target && target.postedBalanceMinor + job.amountMinor;
    const code = current.code || (!target ? 'DESTINATION_ACCOUNT_UNAVAILABLE' :
      !balanceInteger(nextBalance) ? 'DESTINATION_BALANCE_LIMIT' : null);
    const now = new Date();
    const receipt = { transferId: job.transferId, fromAccountId: job.fromAccountId, toAccountId: job.toAccountId,
      amountMinor: job.amountMinor, currency: 'INR', type: job.type, requestedByUid: job.fromUid,
      status: code ? 'REJECTED' : 'COMPLETED', ...(code ? { code } : { completedAt: now }), createdAt: job.createdAt };
    const writes = [db.create(path, receipt)];
    if (!code) writes.push(
      db.patch(current.accountSnapshot, { postedBalanceMinor: current.source.postedBalanceMinor - job.amountMinor,
        updatedAt: now }),
      db.patch(targetSnapshot, { postedBalanceMinor: nextBalance, updatedAt: now }),
      fundingWrite(db, current, job, now),
      journalEntry(db, job, job.fromAccountId, 'DEBIT', now),
      journalEntry(db, job, job.toAccountId, 'CREDIT', now),
    );
    await db.commit(writes);
    return receipt;
  });
}
