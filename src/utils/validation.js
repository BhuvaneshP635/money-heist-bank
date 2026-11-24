export const validators = {
  email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone: v => /^\d{10}$/.test(v),
  pin: v => /^\d{6}$/.test(v),
  password: v => typeof v === 'string' && v.length >= 8,
  required: v => String(v ?? '').trim().length > 0,
};
export function validateRegistration(v) {
  const errors = {};
  for (const key of ['name','email','phone','dob','address','city','state','pinCode','password']) if (!validators.required(v[key])) errors[key] = 'This field is required';
  if (v.email && !validators.email(v.email)) errors.email = 'Enter a valid email';
  if (v.phone && !validators.phone(v.phone)) errors.phone = 'Enter a 10-digit phone number';
  if (v.pinCode && !validators.pin(v.pinCode)) errors.pinCode = 'Enter a 6-digit PIN code';
  if (v.password && !validators.password(v.password)) errors.password = 'Use at least 8 characters';
  if (v.password !== v.confirmPassword) errors.confirmPassword = 'Passwords do not match';
  return errors;
}
