import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import * as fb from '../services/firebase-rest';
import { configuredEndpoint, liveApi } from '../live-api';
import { verifyAdmin } from '../services/admin-service';

const AuthContext = createContext(null);
const KEY = 'mhb-auth-v2';

function persist(session) {
  if (session) localStorage.setItem(KEY, JSON.stringify(session));
  else localStorage.removeItem(KEY);
}

async function authenticateWithBank(email, password, firebaseSession) {
  // Keep the original Central Bank Worker sign-in endpoint as the authority
  // for enabling access to the P635 banking dashboard and transfer APIs.
  const bankSession = await liveApi(configuredEndpoint, '/banks/P635/sign-in', {
    data: { email: email.trim(), password },
  });
  if (firebaseSession && bankSession.uid !== firebaseSession.localId) {
    throw new Error('Firebase and Central Bank sign-in returned different customer identities.');
  }
  return {
    ...bankSession,
    localId: bankSession.uid,
    idToken: bankSession.token,
    refreshToken: firebaseSession?.refreshToken || null,
    expiresAt: bankSession.expiresAt || Date.now() + 55 * 60 * 1000,
  };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function refreshIfNeeded() {
      if (!session?.refreshToken || (session.expiresAt && session.expiresAt > Date.now() + 5 * 60 * 1000)) return;
      try {
        const refreshed = await fb.refreshToken(session.refreshToken);
        if (!active) return;
        const next = {
          ...session,
          token: refreshed.id_token,
          idToken: refreshed.id_token,
          refreshToken: refreshed.refresh_token || session.refreshToken,
          expiresAt: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
        };
        setSession(next);
        persist(next);
      } catch {
        if (active) { setSession(null); persist(null); }
      }
    }
    refreshIfNeeded();
    const timer = window.setInterval(refreshIfNeeded, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [session]);

  async function login(email, password) {
    setLoading(true);
    try {
      const firebaseSession = await fb.signIn(email, password);
      const next = await authenticateWithBank(email, password, firebaseSession);
      next.role = 'customer';
      setSession(next); persist(next);
      return next;
    } finally { setLoading(false); }
  }

  async function register(form) {
    setLoading(true);
    try {
      const created = await fb.signUp(form.email.trim(), form.password);
      const profile = {
        uid: created.localId, name: form.name.trim(), email: form.email.trim().toLowerCase(),
        phone: form.phone, dob: form.dob, address: form.address.trim(), city: form.city.trim(),
        state: form.state.trim(), pinCode: form.pinCode, createdAt: new Date().toISOString(),
        accountProvisioningStatus: 'PENDING_BACKEND',
      };
      await fb.setDoc('customers', created.localId, profile, created.idToken);
      // Registration and profile creation use the bank Firebase project. The Worker
      // session is established separately through its existing sign-in endpoint.
      const next = await authenticateWithBank(form.email, form.password, created);
      next.role = 'customer';
      next.profile = profile;
      setSession(next); persist(next);
      return next;
    } finally { setLoading(false); }
  }

  async function loginAdmin(email, password) {
    setLoading(true);
    try {
      const firebaseSession = await fb.signIn(email, password);
      const next = await authenticateWithBank(email, password, firebaseSession);
      await verifyAdmin(next.localId, next.token);
      next.role = 'admin';
      setSession(next); persist(next);
      return next;
    } finally { setLoading(false); }
  }

  function logout() { setSession(null); persist(null); }
  const value = useMemo(() => ({
    session, loading, login, register, loginAdmin, logout,
    token: session?.token || session?.idToken,
    user: session ? { localId: session.localId || session.uid, email: session.email } : null,
  }), [session, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
