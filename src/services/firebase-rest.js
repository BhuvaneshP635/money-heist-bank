const API_KEY = import.meta.env.VITE_FIREBASE_API_KEY || '';
const PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID || 'money-heist-bank-p635';
const AUTH = 'https://identitytoolkit.googleapis.com/v1';
const DB = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
function requireConfig() { if (!API_KEY) throw new Error('Firebase is not configured. Set VITE_FIREBASE_API_KEY in .env.local.'); }
async function request(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || `Request failed (${res.status})`);
  return body;
}
export async function signUp(email, password) {
  requireConfig();
  return request(`${AUTH}/accounts:signUp?key=${API_KEY}`, { method: 'POST', body: JSON.stringify({ email, password, returnSecureToken: true }) });
}
export async function signIn(email, password) {
  requireConfig();
  return request(`${AUTH}/accounts:signInWithPassword?key=${API_KEY}`, { method: 'POST', body: JSON.stringify({ email, password, returnSecureToken: true }) });
}
export async function refreshToken(refresh_token) {
  requireConfig();
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || 'Token refresh failed');
  return body;
}
const encode = value => {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)])) } };
  return { nullValue: null };
};
const decode = value => {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decode(v)]));
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  return null;
};
function unpack(doc) {
  return { id: doc.name.split('/').pop(), ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, decode(v)])) };
}
export async function getDoc(collection, id, token) {
  const res = await fetch(`${DB}/${collection}/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || 'Firestore read failed');
  return unpack(body);
}
export async function setDoc(collection, id, data, token) {
  return request(`${DB}/${collection}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) }) });
}
export async function updateDoc(collection, id, data, token) {
  const query = new URLSearchParams();
  Object.keys(data).forEach(key => query.append('updateMask.fieldPaths', key));
  return request(`${DB}/${collection}/${encodeURIComponent(id)}?${query}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encode(v)])) }) });
}
export async function listCollection(collection, token, pageSize = 100) {
  const body = await request(`${DB}/${collection}?pageSize=${pageSize}`, { headers: { Authorization: `Bearer ${token}` } });
  return (body.documents || []).map(unpack);
}
export async function queryCollection(collection, field, value, token) {
  const body = await request(`${DB}:runQuery`, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encode(value) } },
      limit: 100,
    } }) });
  return body.filter(row => row.document).map(row => unpack(row.document));
}
export const firebaseProjectId = PROJECT_ID;
