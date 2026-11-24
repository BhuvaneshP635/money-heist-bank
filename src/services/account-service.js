import { configuredEndpoint, liveApi } from '../live-api';
export async function getCustomerBankData(token) {
  return liveApi(configuredEndpoint, '/banks/P635/dashboard', { token });
}
export async function findCustomerAccount(uid, token) {
  const dashboard = await getCustomerBankData(token);
  const accounts = dashboard.accounts || [];
  return { profile: null, accounts, provisioningStatus: accounts.length ? 'PROVISIONED' : 'PENDING_BACKEND' };
}
export async function provisionAccount() {
  throw new Error('The supplied Worker has no public account-provisioning endpoint. An authorized operator can attach or create a synthetic account using support/worker/tools/configure.mjs.');
}
