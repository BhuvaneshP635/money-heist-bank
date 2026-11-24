import { queryCollection, setDoc, updateDoc } from './firebase-rest';
import { newId } from '../utils/formatters';
export async function submitLoan(input, user, token) {
  const amountRupees = Number(input.amountRupees);
  const tenureMonths = Number(input.tenureMonths);
  const annualRatePercent = Number(input.annualRatePercent);
  if (!Number.isFinite(amountRupees) || amountRupees < 1000 || !Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 360 || !Number.isFinite(annualRatePercent) || annualRatePercent < 0 || annualRatePercent > 60 || !String(input.purpose || '').trim()) {
    throw new Error('Enter a valid loan amount, interest rate, tenure and purpose.');
  }
  const id = newId('LN-P635');
  const doc = {
    uid: user.localId, email: user.email, loanType: input.loanType,
    amountRupees, amountMinor: Math.round(amountRupees * 100), annualRatePercent,
    tenureMonths, purpose: String(input.purpose).trim(), status: 'PENDING', createdAt: new Date().toISOString(),
  };
  await setDoc('loan_applications', id, doc, token);
  return { id, ...doc };
}
export async function getLoans(token, uid) { return queryCollection('loan_applications', 'uid', uid, token); }
export async function reviewLoan(id, status, reason, admin, token) {
  if (!['PENDING_DISBURSEMENT', 'REJECTED'].includes(status)) throw new Error('Invalid review status');
  if (status === 'REJECTED' && !String(reason || '').trim()) throw new Error('A rejection reason is required.');
  return updateDoc('loan_applications', id, {
    status, reviewReason: String(reason || '').trim(), reviewedAt: new Date().toISOString(), reviewedBy: admin.localId,
  }, token);
}
