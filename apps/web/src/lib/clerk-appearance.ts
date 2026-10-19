import type { ComponentProps } from 'react';
import type { ClerkProvider } from '@clerk/nextjs';
/**
 * Clerk components (sign-in, sign-up, organization list and switcher, user button) in the
 * Evenbooks look. Every value points at the theme variables in globals.css, so the components
 * follow Ledger (light) and Midnight (dark) with the rest of the app, including the per-browser
 * override. See docs/brand-bible.md.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: 'var(--color-brand-600)',
    colorPrimaryForeground: 'var(--color-white)',
    colorBackground: 'var(--color-white)',
    colorForeground: 'var(--color-stone-900)',
    colorMuted: 'var(--color-stone-50)',
    colorMutedForeground: 'var(--color-stone-600)',
    colorNeutral: 'var(--color-stone-900)',
    colorInput: 'var(--color-white)',
    colorInputForeground: 'var(--color-stone-900)',
    colorBorder: 'var(--color-stone-300)',
    colorRing: 'var(--color-brand-500)',
    colorDanger: 'var(--color-red-600)',
    fontFamily: 'var(--font-sans)',
    fontFamilyButtons: 'var(--font-sans)',
    borderRadius: 'var(--radius-md)',
  },
  // Clerk draws field edges as a translucent shadow (about 10 percent of colorBorder), too faint
  // on the cream and midnight surfaces; give inputs (while not focused; Clerk's focus ring already uses colorPrimary)
  // and the social button a solid theme edge. Clerk's own selectors are more specific, hence !important.
  elements: {
    formFieldInput: { '&:not(:focus)': { boxShadow: '0 0 0 1px var(--color-stone-300) !important' } },
    socialButtonsBlockButton: { boxShadow: '0 0 0 1px var(--color-stone-300) !important' },
  },
} as const;

/**
 * Clerk's own words, changed where they say "organization": in Evenbooks each organization is a
 * company with its own books. Only these keys are overridden; the rest stay Clerk's English.
 */
export const clerkLocalization = {
  formFieldLabel__organizationName: 'Company name',
  formFieldLabel__organizationSlug: 'Short name',
  organizationSwitcher: {
    notSelected: 'No company selected',
    action__createOrganization: 'Create a company',
    action__manageOrganization: 'Manage company',
    action__openOrganizationSwitcher: 'Switch company',
    action__closeOrganizationSwitcher: 'Close the company list',
  },
  createOrganization: {
    title: 'Create a company',
    formButtonSubmit: 'Create company',
  },
  organizationList: {
    title: 'Choose a company',
    titleWithoutPersonal: 'Choose a company',
    subtitle: 'to continue to Evenbooks',
    createOrganization: 'Create a company',
    action__createOrganization: 'Create a company',
  },
  organizationProfile: {
    navbar: { title: 'Company', description: 'Your company and the people in it.' },
    start: { headerTitle__general: 'Company' },
    profilePage: {
      title: 'Company profile',
      dangerSection: {
        leaveOrganization: { title: 'Leave company', messageLine1: 'Are you sure you want to leave this company? You will lose access to its books.' },
        deleteOrganization: { title: 'Delete company', messageLine1: 'Are you sure you want to delete this company?' },
      },
    },
    invitePage: { subtitle: 'Invite people to this company’s books.' },
  },
  taskChooseOrganization: {
    title: 'Choose a company',
    subtitle: 'Each company keeps its own books.',
    chooseOrganization: { title: 'Choose a company', action__createOrganization: 'Create a company' },
    createOrganization: { title: 'Create a company', formButtonSubmit: 'Create company', formFieldLabel__name: 'Company name' },
  },
} satisfies NonNullable<ComponentProps<typeof ClerkProvider>['localization']>;
