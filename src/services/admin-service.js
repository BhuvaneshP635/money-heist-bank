import { getDoc, listCollection } from './firebase-rest';
export async function verifyAdmin(uid, token) {
  const record = await getDoc('admins', uid, token);
  if (!record || record.active === false) throw new Error('This Firebase account is not authorized as a bank administrator.');
  return record;
}
export async function getAdminOverview(token) {
  const [customers, loans, accounts] = await Promise.all([
    listCollection('customers', token), listCollection('loan_applications', token), listCollection('accounts', token),
  ]);
  return {
    customers, loans, accounts,
    activeAccounts: accounts.filter(account => account.status === 'ACTIVE').length,
    suspendedAccounts: accounts.filter(account => ['BLOCKED', 'SUSPENDED'].includes(account.status)).length,
  };
}
export async function changeAccountStatus() {
  throw new Error('Account blocking requires a trusted Worker endpoint with authorization and audit logging. The browser must not change account status directly.');
}
