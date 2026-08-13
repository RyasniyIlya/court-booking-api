import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Віджет бронювання кортів.
 * Вбудовується на сайт клубу. Стилі скоповані префіксом cb- і не залежать
 * від CSS сторінки-господаря, тому вигляд не поїде на чужому сайті.
 *
 * <CourtBookingWidget apiBase="https://api.example.com" slug="squash-arena" />
 */

const STYLES = `
.cb-root {
  --cb-ink: #101418;
  --cb-muted: #6E7671;
  --cb-line: #E4E7E4;
  --cb-court: #0F7A5A;
  --cb-court-soft: #E8F3EF;
  --cb-warn: #B4442E;
  --cb-surface: #FFFFFF;

  all: initial;
  display: block;
  box-sizing: border-box;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--cb-ink);
  background: var(--cb-surface);
  font-size: 15px;
  line-height: 1.45;
  max-width: 560px;
  margin: 0 auto;
  padding: 20px 16px 28px;
  border: 1px solid var(--cb-line);
  border-radius: 14px;
}
.cb-root *, .cb-root *::before, .cb-root *::after { box-sizing: border-box; }

.cb-eyebrow {
  font-size: 11px; letter-spacing: .14em; text-transform: uppercase;
  color: var(--cb-muted); margin: 0 0 4px;
}
.cb-title { font-size: 21px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 18px; }

/* Смуга днів */
.cb-days { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 18px; scrollbar-width: none; }
.cb-days::-webkit-scrollbar { display: none; }
.cb-day {
  flex: 0 0 auto; min-width: 56px; padding: 8px 6px; text-align: center;
  border: 1px solid var(--cb-line); border-radius: 10px; background: var(--cb-surface);
  cursor: pointer; font: inherit; color: inherit; transition: border-color .12s, background .12s;
}
.cb-day:hover { border-color: var(--cb-court); }
.cb-day-wd { display: block; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--cb-muted); }
.cb-day-num { display: block; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cb-day[aria-pressed="true"] { background: var(--cb-ink); border-color: var(--cb-ink); color: #fff; }
.cb-day[aria-pressed="true"] .cb-day-wd { color: rgba(255,255,255,.7); }

/* Корт */
.cb-court { border-top: 1px solid var(--cb-line); padding-top: 14px; margin-top: 14px; }
.cb-court:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
.cb-court-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.cb-court-name { font-size: 15px; font-weight: 600; margin: 0; }
.cb-price { font-size: 12px; color: var(--cb-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* Сітка часу */
.cb-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px; }
.cb-slot {
  padding: 10px 4px; border: 1px solid var(--cb-line); border-radius: 8px;
  background: var(--cb-surface); font: inherit; font-size: 14px; font-weight: 550;
  font-variant-numeric: tabular-nums; color: var(--cb-ink);
  cursor: pointer; transition: background .12s, border-color .12s, transform .06s;
}
.cb-slot:hover:not(:disabled) { border-color: var(--cb-court); background: var(--cb-court-soft); }
.cb-slot:active:not(:disabled) { transform: scale(.97); }
.cb-slot:disabled { cursor: default; color: #A9AFAB; }
/* Зайняте не ховаємо: гравець має бачити, що вечір розібрано, і прийти о 14:00.
   Штрихування — цитата з розмітки корту. */
.cb-slot--busy {
  border-color: #EDEFED;
  background: repeating-linear-gradient(-45deg, #F6F7F6 0 5px, #FFFFFF 5px 10px);
}
.cb-slot--sel { background: var(--cb-court); border-color: var(--cb-court); color: #fff; }

.cb-note { font-size: 13px; color: var(--cb-muted); margin: 10px 0 0; }
.cb-closed { padding: 22px 0; text-align: center; color: var(--cb-muted); font-size: 14px; }

/* Форма */
.cb-form { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--cb-line); }
.cb-summary {
  display: flex; justify-content: space-between; gap: 12px; align-items: baseline;
  padding: 12px 14px; background: var(--cb-court-soft); border-radius: 10px; margin-bottom: 14px;
}
.cb-summary-when { font-weight: 600; font-variant-numeric: tabular-nums; }
.cb-summary-sum { font-variant-numeric: tabular-nums; white-space: nowrap; }
.cb-label { display: block; font-size: 12px; color: var(--cb-muted); margin: 0 0 4px; }
.cb-field { margin-bottom: 12px; }
.cb-input {
  width: 100%; padding: 11px 12px; font: inherit; color: var(--cb-ink);
  border: 1px solid var(--cb-line); border-radius: 9px; background: var(--cb-surface);
}
.cb-input:focus-visible { outline: 2px solid var(--cb-court); outline-offset: 1px; border-color: var(--cb-court); }
.cb-btn {
  width: 100%; padding: 13px; font: inherit; font-weight: 600; color: #fff;
  background: var(--cb-court); border: 0; border-radius: 10px; cursor: pointer;
}
.cb-btn:disabled { background: #9BB8AE; cursor: default; }
.cb-btn--ghost { background: none; color: var(--cb-muted); font-weight: 500; padding: 10px; }
.cb-error { color: var(--cb-warn); font-size: 13px; margin: 0 0 12px; }

.cb-done { text-align: center; padding: 28px 8px; }
.cb-done-when { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 6px 0 4px; }

.cb-slot:focus-visible, .cb-day:focus-visible, .cb-btn:focus-visible {
  outline: 2px solid var(--cb-court); outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) { .cb-root * { transition: none !important; } }
`;

const WD = ['НД', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

const hrn = (kop) => `${(kop / 100).toLocaleString('uk-UA')} грн`;

function localDates(count) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    out.push({
      iso: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`,
      day: x.getDate(),
      wd: WD[x.getDay()],
    });
  }
  return out;
}

export default function CourtBookingWidget({ apiBase = '', slug }) {
  const [club, setClub] = useState(null);
  const [date, setDate] = useState(() => localDates(1)[0].iso);
  const [grid, setGrid] = useState(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState(null); // {courtId, courtName, start, end, label, price}
  const [form, setForm] = useState({ customerName: '', customerPhone: '' });
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(null);
  const formRef = useRef(null);

  const days = useMemo(() => localDates(club?.horizonDays ? Math.min(club.horizonDays, 14) : 7), [club]);

  useEffect(() => {
    fetch(`${apiBase}/api/public/clubs/${slug}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setClub)
      .catch(() => setError('Розклад тимчасово недоступний. Спробуйте пізніше.'));
  }, [apiBase, slug]);

  const loadDay = async (d) => {
    setLoading(true);
    setPicked(null);
    try {
      const r = await fetch(`${apiBase}/api/public/clubs/${slug}/availability?date=${d}`);
      setGrid(r.ok ? await r.json() : null);
    } catch {
      setGrid(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDay(date); /* eslint-disable-next-line */ }, [date, slug]);

  const pick = (court, slot) => {
    setError('');
    setPicked({
      courtId: court.courtId,
      courtName: court.courtName,
      start: slot.start,
      end: slot.end,
      label: slot.label,
      price: Math.round((court.pricePerHour * ((new Date(slot.end) - new Date(slot.start)) / 3600000))),
    });
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 40);
  };

  const submit = async () => {
    if (form.customerName.trim().length < 2) return setError('Вкажіть імʼя.');
    if (!/^\+?[0-9\s()-]{9,20}$/.test(form.customerPhone.trim())) return setError('Перевірте номер телефону.');

    setSending(true);
    setError('');
    try {
      const r = await fetch(`${apiBase}/api/public/clubs/${slug}/bookings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courtId: picked.courtId,
          start: picked.start,
          end: picked.end,
          customerName: form.customerName.trim(),
          customerPhone: form.customerPhone.trim(),
        }),
      });

      if (r.status === 409) {
        // Хтось встиг раніше — показуємо оновлену сітку, а не порожню помилку.
        setError('Цей час щойно зайняли. Оберіть інший — сітку оновлено.');
        setPicked(null);
        await loadDay(date);
        return;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error === 'TOO_LATE'
          ? 'До цього часу вже пізно бронювати онлайн. Зателефонуйте адміністратору.'
          : 'Не вдалося зберегти бронь. Спробуйте ще раз.');
        return;
      }

      const data = await r.json();
      setDone({ ...picked, id: data.id, status: data.status });
    } catch {
      setError('Немає звʼязку з сервером. Перевірте інтернет.');
    } finally {
      setSending(false);
    }
  };

  if (done) {
    const d = days.find((x) => x.iso === date);
    return (
      <div className="cb-root">
        <style>{STYLES}</style>
        <div className="cb-done">
          <p className="cb-eyebrow">{done.status === 'CONFIRMED' ? 'Заброньовано' : 'Заявку прийнято'}</p>
          <p className="cb-done-when">{d?.day} числа, {done.label}</p>
          <p className="cb-note">{done.courtName} · {hrn(done.price)}</p>
          <p className="cb-note">
            {done.status === 'CONFIRMED'
              ? 'Чекаємо вас. Якщо плани зміняться — зателефонуйте адміністратору.'
              : 'Адміністратор передзвонить для підтвердження.'}
          </p>
          <button className="cb-btn cb-btn--ghost" onClick={() => { setDone(null); loadDay(date); }}>
            Забронювати ще один час
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cb-root">
      <style>{STYLES}</style>

      <p className="cb-eyebrow">Онлайн-бронювання</p>
      <h2 className="cb-title">{club?.name ?? 'Завантаження…'}</h2>

      <div className="cb-days" role="group" aria-label="Оберіть дату">
        {days.map((d) => (
          <button
            key={d.iso}
            className="cb-day"
            aria-pressed={d.iso === date}
            onClick={() => setDate(d.iso)}
          >
            <span className="cb-day-wd">{d.wd}</span>
            <span className="cb-day-num">{d.day}</span>
          </button>
        ))}
      </div>

      {loading && <p className="cb-closed">Дивимось, що вільно…</p>}

      {!loading && grid?.closed && <p className="cb-closed">Цього дня клуб не працює.</p>}

      {!loading && grid && !grid.closed && grid.courts.map((court) => (
        <div className="cb-court" key={court.courtId}>
          <div className="cb-court-head">
            <h3 className="cb-court-name">{court.courtName}</h3>
            <span className="cb-price">{hrn(court.pricePerHour)} / год</span>
          </div>
          <div className="cb-slots">
            {court.slots.map((s) => {
              const sel = picked?.courtId === court.courtId && picked?.start === s.start;
              return (
                <button
                  key={s.start}
                  className={`cb-slot${!s.available ? ' cb-slot--busy' : ''}${sel ? ' cb-slot--sel' : ''}`}
                  disabled={!s.available}
                  aria-label={`${s.label}, ${court.courtName}, ${s.available ? 'вільно' : 'зайнято'}`}
                  onClick={() => pick(court, s)}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          {court.slots.every((s) => !s.available) && (
            <p className="cb-note">Цього дня все розібрано. Спробуйте наступний.</p>
          )}
        </div>
      ))}

      {picked && (
        <div className="cb-form" ref={formRef}>
          <div className="cb-summary">
            <span className="cb-summary-when">{picked.courtName}, {picked.label}</span>
            <span className="cb-summary-sum">{hrn(picked.price)}</span>
          </div>

          {error && <p className="cb-error">{error}</p>}

          <div className="cb-field">
            <label className="cb-label" htmlFor="cb-name">Імʼя</label>
            <input
              id="cb-name" className="cb-input" value={form.customerName}
              onChange={(e) => setForm({ ...form, customerName: e.target.value })}
              autoComplete="name"
            />
          </div>
          <div className="cb-field">
            <label className="cb-label" htmlFor="cb-phone">Телефон</label>
            <input
              id="cb-phone" className="cb-input" type="tel" placeholder="+380"
              value={form.customerPhone}
              onChange={(e) => setForm({ ...form, customerPhone: e.target.value })}
              autoComplete="tel"
            />
          </div>

          <button className="cb-btn" onClick={submit} disabled={sending}>
            {sending ? 'Бронюємо…' : `Забронювати за ${hrn(picked.price)}`}
          </button>
          <button className="cb-btn cb-btn--ghost" onClick={() => setPicked(null)}>Обрати інший час</button>
        </div>
      )}

      {!picked && error && <p className="cb-error">{error}</p>}
    </div>
  );
}
