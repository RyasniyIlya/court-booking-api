import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './authSecret';

export type CustomerAuth = { scope: 'customer'; customerId: string; clubId: string };

/** 30 днів: це "запам'ятати мене" для гравця, не робоча сесія персоналу. */
export function signCustomerToken(auth: Omit<CustomerAuth, 'scope'>) {
  return jwt.sign({ scope: 'customer', ...auth }, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyCustomerToken(token: string): CustomerAuth | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<CustomerAuth>;
    if (
      payload.scope !== 'customer' ||
      typeof payload.customerId !== 'string' ||
      typeof payload.clubId !== 'string'
    ) {
      return null;
    }
    return { scope: 'customer', customerId: payload.customerId, clubId: payload.clubId };
  } catch {
    return null;
  }
}
