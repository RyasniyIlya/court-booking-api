-- Роль «Бухгалтер»: тільки каса, податок ФОП, боржники, P&L.
--
-- Сама по собі ця міграція нічого не відкриває — вона лише додає значення
-- в enum. Межі ролі (що саме бачить ACCOUNTANT) забезпечує код:
-- routes/admin/shared.ts (requireStaff, blockAccountant) і
-- routes/finance.ts. Новий акаунт цієї ролі клуб заводить сам через
-- POST /api/admin/staff, старі акаунти не чіпаються.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
