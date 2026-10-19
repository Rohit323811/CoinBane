export const clients = [
  { name: "Acme Studio",   avgAmount: 800,  delayMean: 0,  delayStd: 2,  neverPayRate: 0.00, refundRate: 0.02 },
  { name: "Rahul Designs", avgAmount: 500,  delayMean: 12, delayStd: 4,  neverPayRate: 0.05, refundRate: 0.00 },
  { name: "BigCorp Ltd",   avgAmount: 3000, delayMean: 30, delayStd: 8,  neverPayRate: 0.03, refundRate: 0.01 },
  { name: "Nova Startup",  avgAmount: 1200, delayMean: 20, delayStd: 15, neverPayRate: 0.25, refundRate: 0.05 },
  { name: "Pixel Agency",  avgAmount: 900,  delayMean: 7,  delayStd: 3,  neverPayRate: 0.02, refundRate: 0.18 },
  { name: "Maya Co.",      avgAmount: 600,  delayMean: 3,  delayStd: 2,  neverPayRate: 0.01, refundRate: 0.00 },
];

export function randn(mean: number, std: number): number {
  const u = 1 - Math.random(), v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type Invoice = {
  id: string;
  client: string;
  amount: number;
  issued: Date;
  due: Date;
  status: "PAID" | "SENT" | "UNPAID";
  paidDate: Date | null;
  refunded: boolean;
  delayDays: number | null;
};

// Seeded random so history is stable across requests
let seed = 42;
function seededRandom() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function seededRandn(mean: number, std: number): number {
  const u = 1 - seededRandom(), v = seededRandom();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let cachedHistory: Invoice[] | null = null;

export function generateHistory(months = 9): Invoice[] {
  if (cachedHistory) return cachedHistory;

  const invoices: Invoice[] = [];
  const today = new Date();
  let counter = 0;
  for (const c of clients) {
    for (let m = months; m >= 0; m--) {
      const issued = new Date(today);
      issued.setMonth(today.getMonth() - m);
      const due = new Date(issued);
      due.setDate(due.getDate() + 14);
      const amount = Math.round(seededRandn(c.avgAmount, c.avgAmount * 0.2));
      const neverPaid = seededRandom() < c.neverPayRate;
      const delay = Math.max(0, Math.round(seededRandn(c.delayMean, c.delayStd)));
      const paidDate = new Date(due);
      paidDate.setDate(due.getDate() + delay);
      invoices.push({
        id: `inv-${counter++}`,
        client: c.name,
        amount,
        issued,
        due,
        status: neverPaid ? "UNPAID" : paidDate <= today ? "PAID" : "SENT",
        paidDate: neverPaid || paidDate > today ? null : paidDate,
        refunded: seededRandom() < c.refundRate,
        delayDays: neverPaid || paidDate > today ? null : delay,
      });
    }
  }

  cachedHistory = invoices;
  return invoices;
}
