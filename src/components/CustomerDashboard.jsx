import React, { useEffect, useState } from 'react';
import { Alert, Button } from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { getDoc } from '../services/firebase-rest';
import { getCustomerBankData } from '../services/account-service';
import { money, dateTime } from '../utils/formatters';
export default function CustomerDashboard({ goTransfers, goLoans }) {
  const { session, token } = useAuth();
  const [profile, setProfile] = useState(session?.profile || null);
  const [bankData, setBankData] = useState({ accounts: [], transfers: [] });
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([getDoc('customers', session.localId, token), getCustomerBankData(token)])
      .then(([customer, dashboard]) => { if (active) { setProfile(customer); setBankData(dashboard); } })
      .catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [session.localId, token]);
  const accounts = bankData.accounts || [];
  const available = accounts.reduce((sum, account) => sum + Number(account.availableMinor || 0), 0);
  const held = accounts.reduce((sum, account) => sum + Number(account.heldMinor || 0), 0);
  return <>
    <div className="page-head"><div><h1>Welcome, {profile?.name || session.email}</h1><p>Your Money Heist Bank overview · Bank P635</p></div></div>
    {error && <Alert severity="error">{error}</Alert>}
    <div className="accounts">
      <article className="account-card primary-account"><div className="account-head">Available balance</div><div className="account-value">{money(available)}</div><div className="account-foot"><span>{accounts.length ? accounts.map(a => a.accountNumber).join(', ') : 'Account provisioning pending'}</span><span>INR</span></div></article>
      <article className="account-card light-account"><div className="account-head">Held amount</div><div className="account-value">{money(held)}</div><div className="account-foot"><span>{accounts.length} account(s)</span><span>{accounts.every(a => a.status === 'ACTIVE') ? 'ACTIVE' : 'REVIEW STATUS'}</span></div></article>
    </div>
    <section className="panel form-panel"><h2>Quick actions</h2><div className="quick-actions"><Button variant="contained" onClick={goTransfers}>Make a transfer</Button><Button variant="outlined" onClick={goLoans}>Apply for a loan</Button></div>
      {!accounts.length && <Alert severity="info" sx={{ mt: 2 }}>Your profile is registered, but no account is attached to this Firebase UID yet. The supplied Worker has no public account-provisioning endpoint, so an authorized bank operator must provision the account.</Alert>}
    </section>
    <section className="panel form-panel"><h2>Recent transfer activity</h2>{(bankData.transfers || []).length ? bankData.transfers.slice(0, 8).map(row => <div className="loan-row" key={row.transferId}><strong>{row.transferId} · {money(row.amountMinor)}</strong><span>{row.status} · {dateTime(row.createdAt)}</span></div>) : <p>No transfer activity available yet.</p>}</section>
  </>;
}
