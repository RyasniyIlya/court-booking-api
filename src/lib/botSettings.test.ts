import { describe, expect, it } from 'vitest';

import {
  LEAD_OPTIONS,
  canToggle,
  parseSettingsAction,
  rowsFor,
  settingsKeyboard,
  settingsText,
  type NotifySettings,
} from './botSettings';

/**
 * Розмітка екрана «Сповіщення» і розбір натискань.
 *
 * Чисті функції — саме тому їх видно тут повністю, без бази й мережі.
 * Перевіряється те, що ламається мовчки: підпис кнопки, розійшовшись із
 * розбором callback_data, не кидає помилки — кнопка просто перестає
 * працювати.
 */

const on: NotifySettings = {
  tgNotifyBookings: true,
  tgNotifyTournaments: true,
  tgNotifyGroups: true,
  tgNotifySessions: true,
  tgRemindMinutes: 15,
};

const flat = (kb: ReturnType<typeof settingsKeyboard>) => kb.inline_keyboard.flat();

describe('які рядки бачить роль', () => {
  /* Тренеру немає чого вимикати нагадування про турніри — їх йому й так
     не шлють. Вимкнений рядок, який нічого не робить, гірший за його
     відсутність: людина натисне і вирішить, що бот зламався. */
  it('тренер не бачить чужих рядків, власник — тренерського', () => {
    expect(rowsFor('TRAINER')).toEqual(['tgNotifyBookings', 'tgNotifySessions']);
    expect(rowsFor('OWNER')).not.toContain('tgNotifySessions');
    expect(rowsFor('OWNER')).toContain('tgNotifyTournaments');
  });

  it('модератор бачить те саме, що й власник', () => {
    expect(rowsFor('ADMIN')).toEqual(rowsFor('OWNER'));
  });

  /* callback_data приходить від клієнта: кнопку можна натиснути у старому
     повідомленні, надісланому до зміни ролі. */
  it('чужий перемикач заборонено, навіть якщо кнопку підробили', () => {
    expect(canToggle('TRAINER', 'tgNotifyTournaments')).toBe(false);
    expect(canToggle('TRAINER', 'tgNotifySessions')).toBe(true);
    expect(canToggle('OWNER', 'tgNotifySessions')).toBe(false);
  });
});

describe('розбір натискань', () => {
  it('впізнає перемикач і інтервал', () => {
    expect(parseSettingsAction('ntf:tgNotifyGroups')).toEqual({
      kind: 'toggle', key: 'tgNotifyGroups',
    });
    expect(parseSettingsAction('lead:30')).toEqual({ kind: 'lead', minutes: 30 });
  });

  /* Межі не формальність: без них «lead:99999» перетворив би нагадування
     на повідомлення за два місяці до заняття. */
  it('інтервал поза списком відхиляє', () => {
    expect(parseSettingsAction('lead:99999')).toBeNull();
    expect(parseSettingsAction('lead:7')).toBeNull();
    expect(parseSettingsAction('lead:abc')).toBeNull();
    expect(parseSettingsAction('lead:')).toBeNull();
  });

  it('невідоме поле не пролазить у запит до бази', () => {
    expect(parseSettingsAction('ntf:passwordHash')).toBeNull();
    expect(parseSettingsAction('ntf:')).toBeNull();
  });

  /* Префікс свій, не спільний зі звітами: інакше стара кнопка під
     торішнім звітом потрапила б в обробник налаштувань. */
  it('кнопки звітів сюди не потрапляють', () => {
    expect(parseSettingsAction('week:7')).toBeNull();
    expect(parseSettingsAction('day:0')).toBeNull();
    expect(parseSettingsAction(undefined)).toBeNull();
  });
});

describe('екран', () => {
  it('стан кожного рядка видно значком', () => {
    const text = settingsText('OWNER', { ...on, tgNotifyGroups: false });
    expect(text).toContain('🔔 Нові броні');
    expect(text).toContain('🔕 Нагадування про групові');
  });

  it('показує поточний інтервал', () => {
    expect(settingsText('OWNER', { ...on, tgRemindMinutes: 30 })).toContain('30 хв');
  });

  /* Найчастіше питання після вимкнення всього — «а бот ще працює?».
     Відповідаємо до того, як його встигнуть поставити. */
  it('коли вимкнено все — каже, що лишилось', () => {
    const off = { ...on, tgNotifyBookings: false, tgNotifyTournaments: false, tgNotifyGroups: false };
    expect(settingsText('OWNER', off)).toContain('Звіти');
    expect(settingsText('OWNER', on)).not.toContain('не приходить нічого');
  });

  it('поточний інтервал позначено крапкою рівно один раз', () => {
    const lead = flat(settingsKeyboard('OWNER', { ...on, tgRemindMinutes: 30 }))
      .filter((b) => b.callback_data.startsWith('lead:'));

    expect(lead).toHaveLength(LEAD_OPTIONS.length);
    expect(lead.filter((b) => b.text.startsWith('·'))).toHaveLength(1);
    expect(lead.find((b) => b.callback_data === 'lead:30')!.text).toContain('·');
  });

  /* Головне, що тут можна зламати непомітно: кнопка, чий callback_data
     не розбирається назад, мовчки перестає працювати. */
  it('кожну кнопку екрана можна розібрати назад', () => {
    for (const role of ['OWNER', 'ADMIN', 'TRAINER']) {
      for (const btn of flat(settingsKeyboard(role, on))) {
        const action = parseSettingsAction(btn.callback_data);
        expect(action, `${role}: ${btn.callback_data}`).not.toBeNull();
        if (action?.kind === 'toggle') expect(canToggle(role, action.key)).toBe(true);
      }
    }
  });

  /* Telegram ріже callback_data на 64 байтах — мовчки, без помилки. */
  it('callback_data вкладається в межу Telegram', () => {
    for (const btn of flat(settingsKeyboard('OWNER', on))) {
      expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it('тренер бачить рівно свої рядки плюс інтервали', () => {
    const toggles = flat(settingsKeyboard('TRAINER', on))
      .filter((b) => b.callback_data.startsWith('ntf:'));

    expect(toggles).toHaveLength(2);
    expect(toggles.map((b) => b.callback_data)).toContain('ntf:tgNotifySessions');
  });
});
