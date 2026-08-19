// Спільний секрет для двох незалежних видів токенів: клубного (admin.ts)
// і платформного (platform.ts). Дефолт лишається тільки для локальної
// розробки — у production мовчазний відкат означав би, що будь-хто підписує
// собі токен значенням із відкритих джерел, тож там падаємо на старті.
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET не задано — в production це обов’язково.');
}

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
