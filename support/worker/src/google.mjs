import { ApiError } from './errors.mjs';

const utf8 = new TextEncoder();
function b64url(bytes) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decodeBase64Part(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}
export async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createGoogleTokenSource(serviceAccountSecret, send = fetch) {
  let cached;
  async function issue() {
    const account = JSON.parse(serviceAccountSecret || '{}');
    if (typeof account.client_email !== 'string' || typeof account.private_key !== 'string') {
      throw new Error('Set the FIRESTORE_SERVICE_ACCOUNT Worker secret');
    }
    const pem = account.private_key.replace(/-----[^-]+-----|\s/g, '');
    const key = await crypto.subtle.importKey('pkcs8', decodeBase64Part(pem), {
      name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256',
    }, false, ['sign']);
    const now = Math.floor(Date.now() / 1000);
    const endpoint = 'https://oauth2.googleapis.com/token';
    const header = b64url(utf8.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = b64url(utf8.encode(JSON.stringify({
      iss: account.client_email, aud: endpoint, iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/datastore',
    })));
    const parts = header + '.' + payload;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8.encode(parts));
    const response = await send(endpoint, { method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: parts + '.' + b64url(new Uint8Array(signature)),
      }), signal: AbortSignal.timeout(12_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error('Could not authenticate the Worker to Google Cloud');
    cached = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
    return cached.value;
  }
  return async () => {
    if (cached?.expiresAt > Date.now() + 60_000) return cached.value;
    return issue();
  };
}

function claimsFrom(idToken, projectId) {
  try {
    if (typeof idToken !== 'string' || idToken.length > 8192) return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Part(parts[1])));
    if (claims.aud !== projectId || claims.iss !== 'https://securetoken.google.com/' + projectId ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

async function firebase(config, operation, body, send) {
  const endpoint = 'https://identitytoolkit.googleapis.com/v1/accounts:' + operation + '?key=' +
    encodeURIComponent(config.firebaseWebApiKey);
  const response = await send(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = String(data.error?.message || '').split(' : ')[0];
    if (response.status === 429 || code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
      throw new ApiError(429, 'AUTH_THROTTLED', 'Too many sign-in attempts. Try again later.');
    }
    if (response.status >= 500 || response.status === 403 || [
      'API_KEY_INVALID', 'PROJECT_NUMBER_MISMATCH', 'OPERATION_NOT_ALLOWED', 'CONFIGURATION_NOT_FOUND',
    ].includes(code)) {
      throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Firebase sign-in is unavailable for this project.');
    }
    throw new ApiError(401, 'AUTH_REQUIRED', 'Your credentials or session are invalid. Sign in to continue.');
  }
  return data;
}

export function createAuth(send = fetch) {
  return {
    async signIn(config, credentials) {
      const email = typeof credentials?.email === 'string' ? credentials.email.trim() : '';
      const password = credentials?.password;
      if (!email || email.length > 254 || typeof password !== 'string' || !password || password.length > 1024) {
        throw new ApiError(400, 'VALIDATION', 'Enter a valid email and password.');
      }
      const data = await firebase(config, 'signInWithPassword', { email, password, returnSecureToken: true }, send);
      const claims = claimsFrom(data.idToken, config.projectId);
      if (!claims || data.localId !== claims.sub) throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Check the Firebase project configuration.');
      return { token: data.idToken, expiresAt: claims.exp * 1000, uid: claims.sub, email: data.email || email };
    },
    async authenticate(config, request) {
      const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
      const claims = claimsFrom(token, config.projectId);
      if (!claims) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to this bank or switch to continue.');
      // Firebase verifies the ID token's signature before returning the user.
      const result = await firebase(config, 'lookup', { idToken: token }, send);
      const user = result.users?.find(entry => entry.localId === claims.sub);
      const validSince = Number(user?.validSince || 0);
      if (!user || user.disabled || (validSince && (!Number.isFinite(claims.auth_time) || claims.auth_time < validSince))) {
        throw new ApiError(401, 'AUTH_REQUIRED', 'This user session is unavailable.');
      }
      return { uid: claims.sub };
    },
  };
}
