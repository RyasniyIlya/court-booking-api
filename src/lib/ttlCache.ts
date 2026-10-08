/**
 * Маленький TTL-кеш із дедуплікацією.
 *
 * - свіже значення віддається без виклику loader;
 * - паралельні промахи по одному ключу ділять ОДИН in-flight проміс;
 * - відхилений loader не кешується (наступний виклик спробує знову);
 * - null/undefined кешуються як звичайні значення;
 * - понад maxEntries виштовхується найстаріший запис (порядок вставки Map).
 */
export function createTtlCache<V>(ttlMs: number, maxEntries: number) {
  const fresh = new Map<string, { value: V; expires: number }>();
  const inflight = new Map<string, Promise<V>>();

  return {
    async get(key: string, loader: () => Promise<V>): Promise<V> {
      const hit = fresh.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;

      const pending = inflight.get(key);
      if (pending) return pending;

      const p = loader().then(
        (value) => {
          inflight.delete(key);
          fresh.delete(key);
          fresh.set(key, { value, expires: Date.now() + ttlMs });
          while (fresh.size > maxEntries) {
            const oldest = fresh.keys().next().value as string;
            fresh.delete(oldest);
          }
          return value;
        },
        (err) => {
          inflight.delete(key);
          throw err;
        },
      );
      inflight.set(key, p);
      return p;
    },
    delete(key: string) {
      fresh.delete(key);
      inflight.delete(key);
    },
    clear() {
      fresh.clear();
      inflight.clear();
    },
  };
}
