import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Панель адміністратора клубу.
 * Один екран = один день. Головне завдання — за секунду відповісти на дзвінок
 * «чи вільно о сьомій» і швидко скасувати бронь.
 *
 * <AdminPanel apiBase="https://api.example.com" slug="squash-arena" />
 */

const STYLES = `
.ap-root {
  --ap-ink: #101418;
  --ap-muted: #6E7671;
  --ap-line: #E4E7E4;
  --ap-court: #0F7A5A;
  --ap-court-soft: #E8F3EF;
  --ap-warn: #B4442E;
  --ap-warn-soft: #FBEDEA;
  --ap-hold: #8A6D1F;
  --ap-hold-soft: #FBF3DC;

  box-sizing: border-box;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--ap-ink);
  background: #FBFCFB;
  font-size: 15px;
  line-height: 1.45;
  min-height: 100vh;
  padding: 18px 14px 60px;
}
.ap-root *, .ap-root *::before, .ap-root *::after { box-sizing: border-box; }
.ap-wrap { max-width: 720px; margin: 0 auto; }

.ap-eyebrow { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--ap-muted); margin: 0 0 4px; }
.ap-title { font-size: 22px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 16px; }

.ap-days { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 16px; scrollbar-width: none; }
.ap-days::-webkit-scrollbar { display: none; }
.ap-day {
  flex: 0 0 auto; min-width: 54px; padding: 7px 6px; text-align: center;
  border: 1px solid var(--ap-line); border-radius: 10px; background: #fff;
  cursor: pointer; font: inherit; color: inherit;
}
.ap-day-wd { display: block; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--ap-muted); }
.ap-day-num { display: block; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ap-day[aria-pressed="true"] { background: var(--ap-ink); border-color: var(--ap-ink); color: #fff; }
.ap-day[aria-pressed="true"] .ap-day-wd { color: rgba(255,255,255,.7); }

.ap-stats { display: flex; gap: 18px; padding: 12px 14px; background: #fff; border: 1px solid var(--ap-line); border-radius: 12px; margin-bottom: 16px; }
.ap-stat-num { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; display: block; }
.ap-stat-lbl { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ap-muted); }

.ap-card {
  background: #fff; border: 1px solid var(--ap-line); border-left: 3px solid var(--ap-court);
  border-radius: 10px; padding: 12px 14px; margin-bottom: 8px;
  display: flex; gap: 12px; align-items: flex-start; justify-content: space-between;
}
.ap-card--pending { border-left-color: var(--ap-hold); background: var(--ap-hold-soft); }
.ap-card--cancelled { border-left-color: var(--ap-line); opacity: .55; }
.ap-when { font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 0; }
.ap-meta { font-size: 13px; color: var(--ap-muted); margin: 2px 0 0; }
.ap-phone { color: var(--ap-ink); text-decoration: none; border-bottom: 1px solid var(--ap-line); }
.ap-actions { display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto; }

.ap-btn { font: inherit; font-size: 13px; padding: 7px 11px; border-radius: 8px; cursor: pointer; border: 1px solid var(--ap-line); background: #fff; color: var(--ap-ink); white-space: nowrap; }
.ap-btn--go { background: var(--ap-court); border-color: var(--ap-court); color: #fff; }
.ap-btn--kill { color: var(--ap-warn); border-color: #EBD9D4; background: var(--ap-warn-soft); }
.ap-btn:disabled { opacity: .5; cursor: default; }

.ap-empty { padding: 26px 14px; text-align: center; color: var(--ap-muted); background: #fff; border: 1px dashed var(--ap-line); border-radius: 12px; }

.ap-section { margin-top: 26px; }
.ap-section-h { font-size: 13px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--ap-muted); margin: 0 0 10px; }
.ap-panel { background: #fff; border: 1px solid var(--ap-line); border-radius: 12px; padding: 14px; }
.ap-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ap-input, .ap-select { flex: 1 1 130px; padding: 10px 11px; font: inherit; border: 1px solid var(--ap-line); border-radius: 9px; background: #fff; color: var(--ap-ink); }
.ap-label { display: block; font-size: 12px; color: var(--ap-muted); margin: 0 0 4px; }
.ap-error { color: var(--ap-warn); font-size: 13px; margin: 8px 0 0; }
.ap-ok { color: var(--ap-court); font-size: 13px; margin: 8px 0 0; }

.ap-blocks { list-style: none; padding: 0; margin: 12px 0 0; }
.ap-block-item { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 8px 0; border-top: 1px solid var(--ap-line); font-size: 14px; }
.ap-block-when { font-variant-numeric: tabular-nums; }

.ap-login { max-width: 340px; margin: 60px auto; background: #fff; border: 1px solid var(--ap-line); border-radius: 14px; padding: 22px; }
.ap-field { margin-bottom: 12px; }
.ap-btn--wide { width: 100%; padding: 12px; font-size: 15px; font-weight: 600; }

.ap-btn:focus-visible, .ap-day:focus-visible, .ap-input:focus-visible, .ap-select:focus-visible {
  outline: 2px solid var(--ap-court); outline-offset: 2px;
}
`;

const WD = ['НД', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
const TOKEN_KEY = 'cb_admin_token';

const hrn = (kop) => `${(kop / 100).toLocaleString('uk-UA')} грн`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

function dayList(count) {
  const now = new Date();
  return Array.from({ length: count }, (_, i) => {
    const x = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i - 1);
    return {
      iso: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`,
      day: x.getDate(),
      wd: WD[x.getDay()],
    };
  });
}

/** Локальна дата -> межі доби в ISO з таймзоною браузера */
function dayBounds(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return {
    from: new Date(y, m - 1, d, 0, 0, 0).toISOString(),
    to: new Date(y, m - 1, d, 23, 59, 59).toISOString(),
  };
}

function Login({ apiBase, onIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true); setError('');
    try {
      const r = await fetch(`${apiBase}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) { setError('Невірна пошта або пароль.'); return; }
      const { token } = await r.json();
      onIn(token);
    } catch {
      setError('Немає звʼязку з сервером.');
    } finally { setBusy(false); }
  };

  return (
    <div className="ap-root">
      <style>{STYLES}</style>
      <div className="ap-login">
        <p className="ap-eyebrow">Кабінет клубу</p>
        <h1 className="ap-title">Вхід</h1>
        <div className="ap-field">
          <label className="ap-label" htmlFor="ap-em">Пошта</label>
          <input id="ap-em" className="ap-input" style={{ width: '100%' }} value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        <div className="ap-field">
          <label className="ap-label" htmlFor="ap-pw">Пароль</label>
          <input id="ap-pw" className="ap-input" style={{ width: '100%' }} type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
            onKeyDown={(e) => e.key === 'Enter' && go()} />
        </div>
        <button className="ap-btn ap-btn--go ap-btn--wide" onClick={go} disabled={busy}>
          {busy ? 'Заходимо…' : 'Увійти'}
        </button>
        {error && <p className="ap-error">{error}</p>}
      </div>
    </div>
  );
}

export default function AdminPanel({ apiBase = '', slug }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [club, setClub] = useState(null);
  const [date, setDate] = useState(() => dayList(2)[1].iso);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [block, setBlock] = useState({ courtId: '', from: '', to: '', reason: '' });

  const days = useMemo(() => dayList(10), []);

  const auth = useCallback((path, init = {}) => fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  }), [apiBase, token]);

  const signOut = () => { sessionStorage.removeItem(TOKEN_KEY); setToken(''); };

  useEffect(() => {
    if (!token) return;
    fetch(`${apiBase}/api/public/clubs/${slug}`).then((r) => r.json()).then(setClub).catch(() => {});
  }, [apiBase, slug, token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError('');
    const { from, to } = dayBounds(date);
    try {
      const r = await auth(`/api/admin/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (r.status === 401) { signOut(); return; }
      if (!r.ok) { setError('Не вдалося завантажити день.'); return; }
      setBookings(await r.json());
    } catch {
      setError('Немає звʼязку з сервером.');
    } finally { setLoading(false); }
  }, [auth, date, token]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (id, status) => {
    setNotice(''); setError('');
    const r = await auth(`/api/admin/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    if (!r.ok) { setError('Не вдалося змінити бронь.'); return; }
    setNotice(status === 'CANCELLED' ? 'Бронь скасовано, час знову вільний.' : 'Бронь підтверджено.');
    load();
  };

  const addBlock = async () => {
    setNotice(''); setError('');
    if (!block.from || !block.to) { setError('Вкажіть початок і кінець.'); return; }
    const [y, m, d] = date.split('-').map(Number);
    const mk = (hm) => {
      const [hh, mm] = hm.split(':').map(Number);
      return new Date(y, m - 1, d, hh, mm).toISOString();
    };
    const r = await auth('/api/admin/blocks', {
      method: 'POST',
      body: JSON.stringify({
        courtId: block.courtId || null,
        start: mk(block.from),
        end: mk(block.to),
        reason: block.reason || undefined,
      }),
    });
    if (r.status === 409) { setError('На цей час уже стоїть блокування.'); return; }
    if (!r.ok) { setError('Не вдалося закрити час.'); return; }
    setNotice('Час закрито — онлайн його більше не забронюють.');
    setBlock({ courtId: '', from: '', to: '', reason: '' });
    load();
  };

  if (!token) {
    return <Login apiBase={apiBase} onIn={(t) => { sessionStorage.setItem(TOKEN_KEY, t); setToken(t); }} />;
  }

  const active = bookings.filter((b) => b.status !== 'CANCELLED');
  const revenue = active.reduce((s, b) => s + b.priceTotal, 0);
  const pending = active.filter((b) => b.status === 'PENDING').length;

  return (
    <div className="ap-root">
      <style>{STYLES}</style>
      <div className="ap-wrap">
        <p className="ap-eyebrow">{club?.name ?? 'Кабінет клубу'}</p>
        <h1 className="ap-title">Розклад дня</h1>

        <div className="ap-days" role="group" aria-label="Оберіть день">
          {days.map((d) => (
            <button key={d.iso} className="ap-day" aria-pressed={d.iso === date} onClick={() => setDate(d.iso)}>
              <span className="ap-day-wd">{d.wd}</span>
              <span className="ap-day-num">{d.day}</span>
            </button>
          ))}
        </div>

        <div className="ap-stats">
          <div><span className="ap-stat-num">{active.length}</span><span className="ap-stat-lbl">Броней</span></div>
          <div><span className="ap-stat-num">{hrn(revenue)}</span><span className="ap-stat-lbl">На день</span></div>
          {pending > 0 && (
            <div><span className="ap-stat-num">{pending}</span><span className="ap-stat-lbl">Чекають</span></div>
          )}
        </div>

        {error && <p className="ap-error">{error}</p>}
        {notice && <p className="ap-ok">{notice}</p>}

        {loading && <p className="ap-empty">Завантажуємо день…</p>}

        {!loading && bookings.length === 0 && (
          <p className="ap-empty">На цей день броней ще немає.</p>
        )}

        {!loading && bookings.map((b) => (
          <div
            key={b.id}
            className={`ap-card${b.status === 'PENDING' ? ' ap-card--pending' : ''}${b.status === 'CANCELLED' ? ' ap-card--cancelled' : ''}`}
          >
            <div>
              <p className="ap-when">{hhmm(b.startTime)}–{hhmm(b.endTime)} · {b.court.name}</p>
              <p className="ap-meta">
                {b.customerName} · <a className="ap-phone" href={`tel:${b.customerPhone}`}>{b.customerPhone}</a>
              </p>
              <p className="ap-meta">
                {hrn(b.priceTotal)}
                {b.status === 'PENDING' && ' · чекає підтвердження'}
                {b.status === 'CANCELLED' && ' · скасовано'}
                {b.source === 'ADMIN' && ' · додано вручну'}
              </p>
              {b.comment && <p className="ap-meta">{b.comment}</p>}
            </div>

            {b.status !== 'CANCELLED' && (
              <div className="ap-actions">
                {b.status === 'PENDING' && (
                  <button className="ap-btn ap-btn--go" onClick={() => setStatus(b.id, 'CONFIRMED')}>Підтвердити</button>
                )}
                <button className="ap-btn ap-btn--kill" onClick={() => setStatus(b.id, 'CANCELLED')}>Скасувати</button>
              </div>
            )}
          </div>
        ))}

        <div className="ap-section">
          <h2 className="ap-section-h">Закрити час</h2>
          <div className="ap-panel">
            <div className="ap-row">
              <select
                className="ap-select" value={block.courtId}
                onChange={(e) => setBlock({ ...block, courtId: e.target.value })}
                aria-label="Корт"
              >
                <option value="">Весь клуб</option>
                {club?.courts?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input className="ap-input" type="time" value={block.from}
                onChange={(e) => setBlock({ ...block, from: e.target.value })} aria-label="Початок" />
              <input className="ap-input" type="time" value={block.to}
                onChange={(e) => setBlock({ ...block, to: e.target.value })} aria-label="Кінець" />
            </div>
            <div className="ap-row">
              <input className="ap-input" placeholder="Причина: ремонт, турнір, тривога"
                value={block.reason} onChange={(e) => setBlock({ ...block, reason: e.target.value })} />
              <button className="ap-btn ap-btn--go" onClick={addBlock}>Закрити</button>
            </div>
            <p className="ap-meta">Закритий час зникне з віджета, але вже наявні броні залишаться — скасуйте їх окремо.</p>
          </div>
        </div>

        <div className="ap-section">
          <button className="ap-btn" onClick={signOut}>Вийти</button>
        </div>
      </div>
    </div>
  );
}
