'use client';
import * as React from 'react';

type ClerkModule = typeof import('@clerk/nextjs');

/**
 * Where Clerk should mount its popovers. Clerk portals them to document.body by
 * default, which sits beneath a modal <dialog> (the mobile nav drawer lives in the
 * top layer), so menus opened from inside the drawer would show up behind it.
 */
export const PortalContainerContext = React.createContext<(() => HTMLElement | null) | null>(null);

/**
 * A Clerk component loaded lazily, so the dev-auth build never ships Clerk's client
 * bundle, with its popovers rendered into the nearest portal container. `className`
 * styles a wrapper that appears once the component has loaded.
 */
export function LazyClerk({
  name,
  fallback,
  className,
  ...props
}: { name: 'UserButton' | 'OrganizationSwitcher'; fallback: React.ReactNode; className?: string } & Record<string, unknown>) {
  const getContainer = React.useContext(PortalContainerContext);
  const [mod, setMod] = React.useState<ClerkModule | null>(null);
  React.useEffect(() => {
    void import('@clerk/nextjs').then((m) => setMod(m));
  }, []);
  if (!mod) return <>{fallback}</>;
  const Comp = mod[name] as unknown as React.ComponentType<Record<string, unknown>>;
  let el = <Comp {...props} />;
  if (getContainer) el = <mod.UNSAFE_PortalProvider getContainer={getContainer}>{el}</mod.UNSAFE_PortalProvider>;
  return className ? <div className={className}>{el}</div> : el;
}
