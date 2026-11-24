import React, { useEffect, useState } from 'react';
import { Alert, Button, TextField } from '@mui/material';
import { AuthProvider, useAuth } from './context/AuthContext';
import Navigation from './components/Navigation';
import CustomerRegister from './components/CustomerRegister';
import CustomerDashboard from './components/CustomerDashboard';
import CustomerProfile from './components/CustomerProfile';
import CustomerLoans from './components/CustomerLoans';
import AdminLogin from './components/AdminLogin';
import AdminDashboard from './components/AdminDashboard';
import LiveBank from './LiveBank';
import bank from './bank-config';

function Portal() {
  const { session, login, logout, loading } = useAuth();
  const [page, setPage] = useState('dashboard');
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setPage(session?.role === 'admin' ? 'admin' : 'dashboard');
  }, [session?.role]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    try { await login(email, password); }
    catch (failure) { setError(failure.message); }
  }

  function signOut() {
    logout();
    setMode('login');
    setPassword('');
    setError('');
  }

  if (!session && mode === 'register') {
    return <main className="auth-wrap"><CustomerRegister onBack={() => setMode('login')} /></main>;
  }
  if (!session && mode === 'admin') {
    return <main className="auth-wrap"><AdminLogin onBack={() => setMode('login')} /></main>;
  }
  if (!session) {
    return <main className="auth-wrap"><section className="panel auth-card">
      <div className="brand-icon"><span>♠</span></div>
      <h1>Money Heist Bank</h1>
      <p>Secure digital banking portal · P635</p>
      <form className="transfer-form" onSubmit={submit}>
        <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
        {error && <Alert severity="error">{error}</Alert>}
        <Button variant="contained" type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Customer sign in'}</Button>
      </form>
      <div className="quick-actions"><Button onClick={() => setMode('register')}>Create account</Button><Button onClick={() => setMode('admin')}>Admin login</Button></div>
    </section></main>;
  }

  const view = session.role === 'admin'
    ? <AdminDashboard />
    : page === 'profile' ? <CustomerProfile />
      : page === 'loans' ? <CustomerLoans />
        : page === 'transfers' ? <LiveBank bank={bank} switchUrl="https://sriramtpsiog.github.io/SharedDB/" externalSession={session} embedded />
          : <CustomerDashboard goTransfers={() => setPage('transfers')} goLoans={() => setPage('loans')} />;

  return <div className="layout">
    <Navigation page={page} setPage={setPage} role={session.role} onLogout={signOut} bank={bank} />
    <div className="main">
      <header className="topbar"><strong>{bank.name} · {session.role === 'admin' ? 'Administrator' : 'Customer portal'}</strong><Button size="small" onClick={signOut}>Sign out</Button></header>
      <main className="content">{view}</main>
    </div>
  </div>;
}

export default function App() {
  return <AuthProvider><Portal /></AuthProvider>;
}
