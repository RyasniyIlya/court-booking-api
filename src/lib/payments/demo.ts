/** Explicit opt-in for a hosted prototype. Real providers are unaffected. */
export function mockPaymentsEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.DEMO_PAYMENTS === 'true';
}
