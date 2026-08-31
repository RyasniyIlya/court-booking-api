#!/usr/bin/env bash
#
# Перевірка, що платіжка клуба піднялась на живому сервері.
#
# Робить два запити: /health і завідомо НЕвалідний вебхук. Другий безпечний
# саме тому, що підпис кривий: далі перевірки підпису запит не проходить,
# у базі нічого не змінюється, грошей не рухає. Але код відповіді розрізняє
# три стани, які інакше видно тільки з логів Render.
#
#   404 PAYMENTS_OFF  — клуб є, провайдер не піднявся (немає токена,
#                       або обрано mock, який у production вимкнено)
#   400 BAD_WEBHOOK   — провайдер піднявся, підпис перевірено й відхилено.
#                       Це і є «все ок»
#   404 NOT_FOUND     — такого clubId немає
#
# Використання:
#   ./scripts/pay-check.sh <clubId> [baseUrl]
#   ./scripts/pay-check.sh fad566eb-c82f-4d18-9d70-aa180055d8ee
#   ./scripts/pay-check.sh <clubId> http://localhost:3000

set -euo pipefail

CLUB="${1:-}"
BASE="${2:-https://court-booking-api.onrender.com}"
BASE="${BASE%/}"

if [ -z "$CLUB" ]; then
  echo "Вкажіть clubId: ./scripts/pay-check.sh <clubId> [baseUrl]" >&2
  echo "clubId видно в кабінеті: Клуб -> Передоплата -> адреса вебхука, останній сегмент." >&2
  exit 2
fi

echo "Сервер: $BASE"
echo "Клуб:   $CLUB"
echo

# ── 1. Чи взагалі живий сервіс ────────────────────────────────────────────
health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/health" || echo "000")

if [ "$health" = "200" ]; then
  echo "[1/2] health .......... 200 OK"
else
  echo "[1/2] health .......... $health"
  if [ "$health" = "000" ]; then
    echo "      Сервер не відповів. Render міг ще не підняти інстанс — спробуйте ще раз."
  fi
  exit 1
fi

# ── 2. Вебхук із кривим підписом ──────────────────────────────────────────
# 'bm90LWEtc2lnbmF0dXJl' — це base64 від "not-a-signature".
body=$(curl -s -w '\n%{http_code}' --max-time 30 \
  -X POST "$BASE/api/pay/webhook/$CLUB" \
  -H 'Content-Type: application/json' \
  -H 'x-sign: bm90LWEtc2lnbmF0dXJl' \
  -d '{"invoiceId":"probe","status":"success","amount":100}' || true)

code=$(printf '%s' "$body" | tail -n1)
json=$(printf '%s' "$body" | sed '$d')

echo "[2/2] webhook ......... $code $json"
echo

case "$code" in
  400)
    echo "✅ Платіжка налаштована."
    echo "   Провайдер піднявся, підпис перевірено й відхилено — саме те, що треба."
    exit 0
    ;;
  404)
    case "$json" in
      *PAYMENTS_OFF*)
        echo "⚠️  Провайдер не піднявся."
        echo "   Найчастіше: не вставлений токен еквайрингу."
        echo "   Рідше: обрано «заглушку для тестів», а вона в production вимкнена."
        echo
        echo "   УВАГА: у цьому стані броні створюються БЕЗ оплати, навіть якщо"
        echo "   тумблер «Брати 100% оплату онлайн» увімкнений (public.ts:537)."
        ;;
      *)
        echo "❌ Клуб не знайдений. Перевірте clubId."
        ;;
    esac
    exit 1
    ;;
  *)
    echo "❓ Несподівана відповідь. Дивіться логи Render."
    exit 1
    ;;
esac
