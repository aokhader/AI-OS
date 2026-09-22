/** Synthetic members and accounts. One store per app instance so tests stay isolated. */

export const ACCOUNT_TYPES = ['Savings', 'Checking', 'Money Market', 'Certificate'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface Account {
  number: string;
  type: AccountType;
  balance: number;
  opened: string;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  status: 'Active' | 'Closed';
  memberSince: string;
  accounts: Account[];
}

export interface Confirmation {
  number: string;
  memberId: string;
  account: Account;
  at: string;
}

export interface Bank {
  findMember(id: string): Member | undefined;
  openAccount(
    memberId: string,
    type: AccountType,
    deposit: number,
  ): { confirmation: Confirmation } | { error: 'not_found' | 'closed' };
  getConfirmation(number: string): Confirmation | undefined;
}

function seed(): Member[] {
  return [
    {
      id: '10001',
      firstName: 'Alex',
      lastName: 'Rivera',
      status: 'Active',
      memberSince: '2014-03-11',
      accounts: [
        { number: '10001-S01', type: 'Savings', balance: 1250.75, opened: '2014-03-11' },
        { number: '10001-C01', type: 'Checking', balance: 310.2, opened: '2015-08-02' },
      ],
    },
    {
      id: '10002',
      firstName: 'Jordan',
      lastName: 'Lee',
      status: 'Active',
      memberSince: '2019-11-27',
      accounts: [{ number: '10002-S01', type: 'Savings', balance: 84.1, opened: '2019-11-27' }],
    },
    {
      id: '10003',
      firstName: 'Sam',
      lastName: 'Okafor',
      status: 'Active',
      memberSince: '2008-06-30',
      accounts: [
        { number: '10003-S01', type: 'Savings', balance: 15400, opened: '2008-06-30' },
        { number: '10003-C01', type: 'Checking', balance: 2200.55, opened: '2008-07-14' },
        { number: '10003-M01', type: 'Money Market', balance: 5000, opened: '2021-01-05' },
      ],
    },
    {
      id: '10004',
      firstName: 'Taylor',
      lastName: 'Brooks',
      status: 'Closed',
      memberSince: '2011-02-18',
      accounts: [{ number: '10004-S01', type: 'Savings', balance: 0, opened: '2011-02-18' }],
    },
  ];
}

const TYPE_CODES: Record<AccountType, string> = {
  Savings: 'S',
  Checking: 'C',
  'Money Market': 'M',
  Certificate: 'D',
};

export function createBank(): Bank {
  const members = new Map(seed().map((m) => [m.id, m]));
  const confirmations = new Map<string, Confirmation>();
  let nextConfirmation = 480221;

  return {
    findMember(id) {
      return members.get(id.trim());
    },
    openAccount(memberId, type, deposit) {
      const member = members.get(memberId);
      if (!member) return { error: 'not_found' };
      if (member.status === 'Closed') return { error: 'closed' };
      const code = TYPE_CODES[type];
      const ordinal = member.accounts.filter((a) => a.type === type).length + 1;
      const account: Account = {
        number: `${member.id}-${code}${String(ordinal).padStart(2, '0')}`,
        type,
        balance: deposit,
        opened: new Date().toISOString().slice(0, 10),
      };
      member.accounts.push(account);
      const confirmation: Confirmation = {
        number: `C-${nextConfirmation++}`,
        memberId: member.id,
        account,
        at: new Date().toISOString(),
      };
      confirmations.set(confirmation.number, confirmation);
      return { confirmation };
    },
    getConfirmation(number) {
      return confirmations.get(number);
    },
  };
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatMoney(n: number): string {
  return usd.format(n);
}
