import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Chip, TextField } from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { getAdminOverview } from '../services/admin-service';
import { money, dateTime } from '../utils/formatters';
import { reviewLoan } from '../services/loan-service';
export default function AdminDashboard() {
  const { token, session } = useAuth();
  const [data, setData] = useState({ customers: [], loans: [], accounts: [], activeAccounts: 0, suspendedAccounts: 0 });
  const [error, setError] = useState('');
  const [reason, setReason] = useState({});
  const [search, setSearch] = useState('');
  async function load() { try { setData(await getAdminOverview(token)); setError(''); } catch (failure) { setError(failure.message); } }
  useEffect(() => { load(); }, [token]);
  async function decide(row, status) { try { await reviewLoan(row.id, status, reason[row.id] || '', session, token); await load(); } catch (failure) { setError(failure.message); } }
  const customers = useMemo(() => { const q = search.toLowerCase(); const accountUids = data.accounts.filter(a => [a.accountNumber, a.id, a.accountId].some(v => String(v || '').toLowerCase().includes(q))).map(a => a.customerUid); return data.customers.filter(c => [c.name, c.email, c.phone, c.uid].some(v => String(v || '').toLowerCase().includes(q)) || accountUids.includes(c.uid)); }, [data.customers, data.accounts, search]);
  return <>
    <div className="page-head"><div><h1>Admin dashboard</h1><p>Operational overview · Money Heist Bank · P635</p></div></div>
    {error && <Alert severity="error">{error}</Alert>}
    <div className="stats-grid">{[['Customers', data.customers.length], ['Active accounts', data.activeAccounts], ['Blocked / suspended', data.suspendedAccounts], ['Loan applications', data.loans.length]].map(([label, value]) => <article className="stat-card" key={label}><span>{label}</span><strong>{value}</strong></article>)}</div>
    <section className="panel form-panel"><h2>Loan review queue</h2>{data.loans.length ? data.loans.map(row => <div className="loan-row" key={row.id}><strong>{row.email} · {row.loanType} · {money(row.amountMinor)}</strong><span><Chip label={row.status} /></span><p>{row.purpose} · {dateTime(row.createdAt)}</p>{row.status === 'PENDING' && <><TextField size="small" fullWidth label="Review reason (required for rejection)" value={reason[row.id] || ''} onChange={e => setReason({ ...reason, [row.id]: e.target.value })} /><div className="quick-actions"><Button onClick={() => decide(row, 'PENDING_DISBURSEMENT')}>Approve</Button><Button color="error" onClick={() => decide(row, 'REJECTED')}>Reject</Button></div></>}</div>) : <p>No loan applications found.</p>}</section>
    <section className="panel form-panel"><h2>Customer directory</h2><TextField fullWidth size="small" label="Search name, email, phone, UID or account number" value={search} onChange={e => setSearch(e.target.value)} sx={{ mb: 2 }} />{customers.map(customer => <div className="loan-row" key={customer.uid}><strong>{customer.name}</strong><span>{customer.email} · {customer.phone}</span><small>UID: {customer.uid}</small></div>)}{!customers.length && <p>No matching customers.</p>}</section>
    <section className="panel form-panel"><h2>Account directory</h2>{data.accounts.filter(account => [account.accountNumber, account.id, account.customerUid].some(v => String(v || '').toLowerCase().includes(search.toLowerCase()))).map(account => <div className="loan-row" key={account.id}><strong>{account.accountNumber || account.id} · {account.label || 'Bank account'}</strong><span>{account.status} · {money(account.postedBalanceMinor || 0)}</span><small>Customer UID: {account.customerUid || '—'} · Held: {money(account.heldMinor || 0)}</small></div>)}{!data.accounts.length && <p>No accounts provisioned yet.</p>}<Alert severity="info" sx={{ mt: 2 }}>Account blocking/suspension is intentionally not enabled in the browser. It requires a trusted Worker endpoint that verifies admin privileges and writes an audit record.</Alert></section>
  </>;
}
