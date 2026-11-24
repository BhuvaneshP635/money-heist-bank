import React, { useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@mui/material';
import { getDoc, updateDoc } from '../services/firebase-rest';
import { getCustomerBankData } from '../services/account-service';
import { useAuth } from '../context/AuthContext';
export default function CustomerProfile() {
  const { session, token } = useAuth();
  const [data, setData] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([getDoc('customers', session.localId, token), getCustomerBankData(token)])
      .then(([profile, dashboard]) => { if (active) { setData(profile || {}); setAccounts(dashboard.accounts || []); } })
      .catch(failure => { if (active) setMsg(failure.message); });
    return () => { active = false; };
  }, [session.localId, token]);
  async function save(event) {
    event.preventDefault(); setMsg('');
    if (!/^\d{10}$/.test(data.phone || '')) return setMsg('Enter a valid 10-digit phone number.');
    if (!/^\d{6}$/.test(data.pinCode || '')) return setMsg('Enter a valid 6-digit PIN code.');
    try {
      await updateDoc('customers', session.localId, {
        phone: data.phone, address: data.address, city: data.city, state: data.state,
        pinCode: data.pinCode, updatedAt: new Date().toISOString(),
      }, token);
      setMsg('Profile updated successfully.');
    } catch (failure) { setMsg(failure.message); }
  }
  return <>
    <section className="panel form-panel"><h1>Customer profile</h1><p>Personal identity details and registered bank account information.</p>
      <form className="form-grid" onSubmit={save}>
        {[['name', 'Full name', true], ['email', 'Email', true], ['dob', 'Date of birth', true], ['phone', '10-digit phone'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['pinCode', '6-digit PIN code']].map(([key, label, readOnly]) => <TextField key={key} label={label} value={data[key] || ''} disabled={Boolean(readOnly)} onChange={event => setData({ ...data, [key]: event.target.value })} />)}
        <div><Button type="submit" variant="contained">Save profile</Button></div>
      </form>
      {msg && <Alert sx={{ mt: 2 }} severity={msg.includes('successfully') ? 'success' : 'error'}>{msg}</Alert>}
    </section>
    <section className="panel form-panel"><h2>Bank account details</h2>{accounts.length ? accounts.map(account => <div className="loan-row" key={account.accountId}><strong>{account.label || 'Savings account'} · {account.accountNumber}</strong><span>IFSC: BHUV0M8F4JQ · Status: {account.status}</span><small>Account ID: {account.accountId} · Currency: {account.currency || 'INR'}</small></div>) : <Alert severity="info">No account is currently attached to this customer profile. Account provisioning is pending with the bank operator.</Alert>}</section>
  </>;
}
