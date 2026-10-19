'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';

export function DevLoginForm({ users, orgs }: { users: { userId: string; userName: string }[]; orgs: { orgId: string; orgName: string }[] }) {
  const router = useRouter();
  const [userId, setUserId] = React.useState(users[0]?.userId ?? '');
  const [orgId, setOrgId] = React.useState(orgs[0]?.orgId ?? '');
  const [role, setRole] = React.useState<'org:admin' | 'org:member'>('org:admin');
  const [busy, setBusy] = React.useState(false);
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await fetch('/api/dev-auth', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId, orgId, orgRole: role }),
        });
        router.push('/dashboard');
        router.refresh();
      }}
    >
      <Field label="User" htmlFor="user">
        <Select id="user" value={userId} onChange={(e) => setUserId(e.target.value)}>
          {users.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.userName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Company" htmlFor="org">
        <Select id="org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.orgId} value={o.orgId}>
              {o.orgName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Role" htmlFor="role">
        <Select id="role" value={role} onChange={(e) => setRole(e.target.value as 'org:admin' | 'org:member')}>
          <option value="org:admin">Admin</option>
          <option value="org:member">Member (bookkeeper)</option>
        </Select>
      </Field>
      <Button type="submit" loading={busy} className="w-full">
        Continue
      </Button>
    </form>
  );
}
