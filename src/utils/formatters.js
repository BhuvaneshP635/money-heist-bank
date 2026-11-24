export const money = (minor = 0) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(minor || 0) / 100);
export const dateTime = value => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
export const newId = prefix => `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0,8)}`;
