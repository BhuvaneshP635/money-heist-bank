export function calculateEmi(principalRupees, annualRatePercent, months) {
  const p = Number(principalRupees), n = Number(months), r = Number(annualRatePercent) / 1200;
  if (!(p > 0) || !(n > 0) || !(r >= 0)) return 0;
  if (r === 0) return p / n;
  return p * r * Math.pow(1+r,n) / (Math.pow(1+r,n)-1);
}
export function buildSchedule(principal, annualRate, months, start = new Date()) {
  const emi = calculateEmi(principal, annualRate, months), rate = annualRate / 1200; let balance = principal;
  return Array.from({length: months}, (_,i) => { const interest=balance*rate, paid=Math.min(balance,emi-interest), row={month:i+1,dueDate:new Date(start.getFullYear(),start.getMonth()+i+1,start.getDate()).toISOString(),emi:paid+interest,principal:paid,interest,balance:Math.max(0,balance-paid)}; balance=row.balance; return row; });
}
