import React, { useEffect, useState } from 'react';
import { Alert, Button, MenuItem, TextField } from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { buildSchedule, calculateEmi } from '../utils/emi-calculator';
import { money, dateTime } from '../utils/formatters';
import { getLoans, submitLoan } from '../services/loan-service';
export default function CustomerLoans() {
  const { session, token } = useAuth();
  const [form, setForm] = useState({ loanType: 'PERSONAL', amountRupees: 100000, annualRatePercent: 12, tenureMonths: 12, purpose: '' });
  const [rows, setRows] = useState([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function load() { try { setRows(await getLoans(token, session.localId)); } catch (failure) { setError(failure.message); } }
  useEffect(() => { load(); }, [token, session.localId]);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await submitLoan(form, session, token); await load(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  const emi = calculateEmi(form.amountRupees, form.annualRatePercent, form.tenureMonths);
  const schedule = Number(form.amountRupees) > 0 && Number(form.annualRatePercent) >= 0 && Number(form.tenureMonths) > 0
    ? buildSchedule(Number(form.amountRupees), Number(form.annualRatePercent), Math.min(12, Number(form.tenureMonths))) : [];
  return <>
    <section className="panel form-panel"><h1>Loan application</h1><p>Apply for one of the five available loan categories.</p>
      <form className="form-grid" onSubmit={submit}>
        <TextField select label="Loan type" value={form.loanType} onChange={event => setForm({ ...form, loanType: event.target.value })}>{['PERSONAL', 'HOME', 'VEHICLE', 'EDUCATION', 'BUSINESS'].map(type => <MenuItem key={type} value={type}>{type}</MenuItem>)}</TextField>
        <TextField label="Amount (INR)" type="number" inputProps={{ min: 1000 }} value={form.amountRupees} onChange={event => setForm({ ...form, amountRupees: event.target.value })} />
        <TextField label="Annual interest rate (%)" type="number" inputProps={{ min: 0, max: 60, step: 0.1 }} value={form.annualRatePercent} onChange={event => setForm({ ...form, annualRatePercent: event.target.value })} />
        <TextField label="Tenure (months)" type="number" inputProps={{ min: 1, max: 360 }} value={form.tenureMonths} onChange={event => setForm({ ...form, tenureMonths: event.target.value })} />
        <TextField label="Purpose" multiline required value={form.purpose} onChange={event => setForm({ ...form, purpose: event.target.value })} />
        <div><p>Estimated monthly EMI</p><h2>{money(Math.round(emi * 100))}</h2></div>
        <div className="form-actions"><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Submitting…' : 'Submit application'}</Button></div>
      </form>
      <h2 style={{ marginTop: 24 }}>Estimated repayment schedule (first 12 months)</h2>
      <div className="table-scroll"><table><thead><tr><th>Month</th><th>EMI</th><th>Principal</th><th>Interest</th><th>Balance</th></tr></thead><tbody>{schedule.map(row => <tr key={row.month}><td>{row.month}</td><td>{money(Math.round(row.emi * 100))}</td><td>{money(Math.round(row.principal * 100))}</td><td>{money(Math.round(row.interest * 100))}</td><td>{money(Math.round(row.balance * 100))}</td></tr>)}</tbody></table></div>
      <Alert severity="info" sx={{ mt: 2 }}>This is an estimate only. Actual repayment dates, collections and outstanding balances require the trusted loan-disbursement and repayment backend; no payment or balance is changed here.</Alert>
      {error && <Alert sx={{ mt: 2 }} severity="error">{error}</Alert>}
    </section>
    <section className="panel form-panel"><h2>My applications</h2>{rows.map(row => <div className="loan-row" key={row.id}><strong>{row.loanType} · {money(row.amountMinor)}</strong><span>{row.status} · {dateTime(row.createdAt)}</span>{row.reviewReason && <p>{row.reviewReason}</p>}</div>)}{!rows.length && <p>No loan applications submitted yet.</p>}</section>
  </>;
}
