export class FirestoreError extends Error {
  constructor(status, data) {
    super(data?.error?.message || 'Firestore returned HTTP ' + status);
    this.status = status;
    this.code = data?.error?.status;
  }
}

export const isConflict = error => error instanceof FirestoreError &&
  ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code);

export function encode(value) {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (Number.isSafeInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number' && Number.isFinite(value)) return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (value && typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError('Unsupported Firestore field value');
}

const encodeFields = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encode(value)]));

export function decode(value) {
  if ('nullValue' in value) return null;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('timestampValue' in value) return new Date(value.timestampValue);
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields);
  const [type, simple] = Object.entries(value)[0];
  if (!['booleanValue', 'stringValue', 'doubleValue', 'referenceValue'].includes(type)) return null;
  return simple;
}

const decodeFields = (values = {}) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, decode(value)]));

export function documentPath(...segments) {
  if (!segments.length || segments.some(segment => typeof segment !== 'string' || !segment ||
    segment.length > 1500 || ['.', '..'].includes(segment) || /[\/\u0000-\u001f]/.test(segment))) {
    throw new TypeError('Invalid Firestore document segment');
  }
  return segments.join('/');
}

export class Firestore {
  constructor({ projectId, token, fetcher = fetch, emulator }) {
    this.projectId = projectId;
    this.token = token;
    this.fetcher = fetcher;
    this.database = 'projects/' + projectId + '/databases/(default)';
    this.name = this.database + '/documents';
    this.base = emulator ? 'http://' + emulator + '/v1/' : 'https://firestore.googleapis.com/v1/';
  }

  async call(path, method = 'GET', body) {
    const send = this.fetcher;
    const response = await send(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await this.token() },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new FirestoreError(response.status, data);
    return data;
  }

  snapshot(document) {
    return { path: document.name.slice(this.name.length + 1), version: document.updateTime,
      data: decodeFields(document.fields) };
  }

  pathUrl(path) { return this.name + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : ''); }

  async get(path) {
    try { return this.snapshot(await this.call(this.pathUrl(path))); }
    catch (error) {
      if (error instanceof FirestoreError && error.status === 404) return null;
      throw error;
    }
  }

  async query(collectionId, { parent = '', where, orderBy, select, limit = 50 } = {}) {
    const structuredQuery = { from: [{ collectionId }], limit };
    if (where) {
      const [fieldPath, op, value] = where;
      structuredQuery.where = { fieldFilter: { field: { fieldPath }, op, value: encode(value) } };
    }
    if (orderBy) {
      const [fieldPath, direction] = orderBy;
      structuredQuery.orderBy = [{ field: { fieldPath }, direction }];
    }
    if (select) structuredQuery.select = { fields: select.map(fieldPath => ({ fieldPath })) };
    const rows = await this.call(this.pathUrl(parent) + ':runQuery', 'POST', { structuredQuery });
    return rows.filter(row => row.document).map(row => this.snapshot(row.document));
  }

  create(path, fields) {
    return { update: { name: this.name + '/' + path, fields: encodeFields(fields) },
      currentDocument: { exists: false } };
  }

  patch(snapshot, fields, remove = []) {
    return {
      update: { name: this.name + '/' + snapshot.path, fields: encodeFields(fields) },
      updateMask: { fieldPaths: [...Object.keys(fields), ...remove] },
      currentDocument: { updateTime: snapshot.version },
    };
  }

  patchExisting(path, fields) {
    return { update: { name: this.name + '/' + path, fields: encodeFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields) }, currentDocument: { exists: true } };
  }

  set(path, snapshot, fields) {
    return snapshot ? this.patch(snapshot, fields) : this.create(path, fields);
  }

  commit(writes) {
    return this.call(this.database + '/documents:commit', 'POST', { writes });
  }
}
