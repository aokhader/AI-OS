/**
 * Two fictional institutions running the same fictional vendor product, configured differently.
 * This is the stand-in for brief §3.7's "many tenants run the same underlying vendor product".
 * Variant B relabels controls and renames the main frame; column reordering lands in P7.
 */
export interface VariantConfig {
  id: 'first-example-cu' | 'sample-federal-cu';
  institution: string;
  product: string;
  productVersion: string;
  mainFrameName: string;
  theme: { headerBg: string; pageBg: string };
  labels: {
    userId: string;
    password: string;
    signIn: string;
    memberLookup: string;
    memberNumber: string;
    search: string;
    searchResults: string;
    view: string;
    actionColumn: string;
    memberDetail: string;
    accounts: string;
    openSubAccount: string;
    openAccount: string;
    accountType: string;
    initialDeposit: string;
    confirmation: string;
    signOut: string;
  };
}

export type VariantKey = 'a' | 'b';

export const variants: Record<VariantKey, VariantConfig> = {
  a: {
    id: 'first-example-cu',
    institution: 'First Example Credit Union',
    product: 'ACME CoreTeller',
    productVersion: '7.4.2',
    mainFrameName: 'main',
    theme: { headerBg: '#1f3b64', pageBg: '#e8ecf0' },
    labels: {
      userId: 'User ID',
      password: 'Password',
      signIn: 'Sign In',
      memberLookup: 'Member Lookup',
      memberNumber: 'Member #',
      search: 'Search',
      searchResults: 'Search Results',
      view: 'View',
      actionColumn: 'Action',
      memberDetail: 'Member Detail',
      accounts: 'Accounts',
      openSubAccount: 'Open sub-account',
      openAccount: 'Open Account',
      accountType: 'Account type',
      initialDeposit: 'Initial deposit',
      confirmation: 'Confirmation',
      signOut: 'Sign out',
    },
  },
  b: {
    id: 'sample-federal-cu',
    institution: 'Sample Federal Credit Union',
    product: 'ACME CoreTeller',
    productVersion: '7.6.0',
    mainFrameName: 'content',
    theme: { headerBg: '#5a1f1f', pageBg: '#f2ede4' },
    labels: {
      userId: 'User ID',
      password: 'Password',
      signIn: 'Sign In',
      memberLookup: 'Member Lookup',
      memberNumber: 'Member Number',
      search: 'Find',
      searchResults: 'Search Results',
      view: 'Open',
      actionColumn: 'Actions',
      memberDetail: 'Member Detail',
      accounts: 'Accounts',
      openSubAccount: 'Open sub-account',
      openAccount: 'Open Account',
      accountType: 'Account type',
      initialDeposit: 'Initial deposit',
      confirmation: 'Confirmation',
      signOut: 'Sign out',
    },
  },
};
