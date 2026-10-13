import { describe, expect, it } from 'vitest';
import { checkDemoStandGuard, parseDatabaseUrl } from './demoStandGuard';

const URL_DEMO = 'postgresql://u:p@ep-demo-pooler.eu-central-1.aws.neon.tech/kort_demo?sslmode=require';

describe('parseDatabaseUrl', () => {
  it('бере назву бази з pathname, ігноруючи query', () => {
    expect(parseDatabaseUrl(URL_DEMO)).toEqual({ dbName: 'kort_demo', host: 'ep-demo-pooler.eu-central-1.aws.neon.tech' });
  });
  it('postgres:// теж підходить', () => {
    expect(parseDatabaseUrl('postgres://u:p@h:5432/db1')?.dbName).toBe('db1');
  });
  it.each([undefined, '', 'не url', 'mysql://u@h/db', 'postgresql://u:p@host', 'postgresql://u:p@host/'])('%s -> null', (v) => {
    expect(parseDatabaseUrl(v)).toBeNull();
  });
});

describe('checkDemoStandGuard', () => {
  const ok = { DEMO_STAND: 'true', DATABASE_URL: URL_DEMO, DEMO_RESET_CONFIRM: 'kort_demo' };

  it('усі умови виконано -> ok', () => {
    expect(checkDemoStandGuard(ok)).toMatchObject({ ok: true, dbName: 'kort_demo' });
  });
  it('DEMO_STAND не "true" -> відмова', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(checkDemoStandGuard({ ...ok, DEMO_STAND: v }).ok).toBe(false);
    }
  });
  it('без DEMO_RESET_CONFIRM -> відмова', () => {
    expect(checkDemoStandGuard({ ...ok, DEMO_RESET_CONFIRM: undefined }).ok).toBe(false);
    expect(checkDemoStandGuard({ ...ok, DEMO_RESET_CONFIRM: '  ' }).ok).toBe(false);
  });
  it('DEMO_RESET_CONFIRM не збігається з назвою бази -> відмова (захист від прод-бази)', () => {
    const r = checkDemoStandGuard({ ...ok, DEMO_RESET_CONFIRM: 'neondb' });
    expect(r.ok).toBe(false);
  });
  it('база без "demo" у назві (типове "neondb" прода) відхиляється, навіть якщо підтвердження збігається', () => {
    const prod = { ...ok, DATABASE_URL: 'postgresql://u:p@host/neondb?sslmode=require', DEMO_RESET_CONFIRM: 'neondb' };
    const r = checkDemoStandGuard(prod);
    expect(r.ok).toBe(false);
    expect(checkDemoStandGuard({ ...prod, DATABASE_URL: 'postgresql://u:p@host/Kort_DEMO', DEMO_RESET_CONFIRM: 'Kort_DEMO' }).ok).toBe(true);
  });
  it('регістр має значення, часткові збіги не проходять', () => {
    expect(checkDemoStandGuard({ ...ok, DEMO_RESET_CONFIRM: 'KORT_DEMO' }).ok).toBe(false);
    expect(checkDemoStandGuard({ ...ok, DEMO_RESET_CONFIRM: 'kort' }).ok).toBe(false);
  });
  it('DIRECT_URL на інший хост тієї ж назви бази -> відмова; "-pooler" різницею не вважається', () => {
    const pooled = { ...ok, DATABASE_URL: 'postgresql://u:p@ep-demo-pooler.eu.neon.tech/kort_demo' };
    expect(checkDemoStandGuard({ ...pooled, DIRECT_URL: 'postgresql://u:p@ep-prod.eu.neon.tech/kort_demo' }).ok).toBe(false);
    expect(checkDemoStandGuard({ ...pooled, DIRECT_URL: 'postgresql://u:p@ep-demo.eu.neon.tech/kort_demo' }).ok).toBe(true);
  });
  it('DIRECT_URL на іншу базу або сміття -> відмова; на ту саму -> ok', () => {
    expect(checkDemoStandGuard({ ...ok, DIRECT_URL: 'postgresql://u:p@host/neondb' }).ok).toBe(false);
    expect(checkDemoStandGuard({ ...ok, DIRECT_URL: 'garbage' }).ok).toBe(false);
    expect(checkDemoStandGuard({ ...ok, DIRECT_URL: 'postgresql://u:p@ep-demo-pooler.eu-central-1.aws.neon.tech/kort_demo' }).ok).toBe(true);
  });
  it('без DATABASE_URL або з сміттям -> відмова', () => {
    expect(checkDemoStandGuard({ ...ok, DATABASE_URL: undefined }).ok).toBe(false);
    expect(checkDemoStandGuard({ ...ok, DATABASE_URL: 'garbage' }).ok).toBe(false);
  });
  it('повідомлення про відмову не містить пароля з рядка підключення', () => {
    const r = checkDemoStandGuard({ ...ok, DEMO_RESET_CONFIRM: 'x', DATABASE_URL: 'postgresql://u:SECRETPW@h/db' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('SECRETPW');
  });
});
