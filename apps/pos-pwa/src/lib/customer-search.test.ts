import { describe, expect, it } from 'vitest';
import { customerQuery } from './customer-search';

describe('customer lookup — what the cashier typed becomes ONE server filter', () => {
  it('nothing typed lists the first page', () => expect(customerQuery('   ')).toEqual({}));
  it('digits (with spaces, dashes or a leading +) search by phone, normalised', () => {
    expect(customerQuery('+971 50-123 4567')).toEqual({ phone: '+971501234567' });
    expect(customerQuery('0501234567')).toEqual({ phone: '0501234567' });
  });
  it('an @ searches by e-mail', () =>
    expect(customerQuery(' dora@shop.test ')).toEqual({ email: 'dora@shop.test' }));
  it('anything else searches by name, trimmed', () =>
    expect(customerQuery('  Dora Deb ')).toEqual({ displayName: 'Dora Deb' }));
  it('a short number is a name fragment, not a phone', () =>
    expect(customerQuery('12')).toEqual({ displayName: '12' }));
});
