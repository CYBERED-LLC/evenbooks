'use client';
import * as React from 'react';
import type { CompanyDto, MembershipRole } from '@evenbooks/contracts';
import { todayIso } from '@/lib/format';

export interface CompanyContextValue {
  company: CompanyDto;
  role: MembershipRole;
  userId: string;
  userName: string | null;
  authMode: 'clerk' | 'dev';
  /** Members the company's plan allows. */
  memberLimit: number;
  /** Server-wide capabilities; hide UI for anything false. */
  features: { onlinePayments: boolean; stripeAccountLinking: boolean };
  isAdmin: boolean;
}

const Ctx = React.createContext<CompanyContextValue | null>(null);

export function CompanyProvider({ value, children }: { value: Omit<CompanyContextValue, 'isAdmin'>; children: React.ReactNode }) {
  const v = React.useMemo(() => ({ ...value, isAdmin: value.role === 'admin' }), [value]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}

export function useCompany(): CompanyContextValue {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useCompany must be used within CompanyProvider');
  return v;
}

/** Today as YYYY-MM-DD in the company's time zone (the browser's outside a company). */
export function useToday(): string {
  const v = React.useContext(Ctx);
  return todayIso(v?.company.timeZone);
}
