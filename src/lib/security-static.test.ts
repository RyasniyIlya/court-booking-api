import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Статичний запобіжник проти регресу, а не тест поведінки.
 *
 * Параметризований SQL і єдиний санітизований `dangerouslySetInnerHTML`
 * тримають XSS/SQLi закритими. Але це властивість коду, яку легко зламати
 * одним недбалим рядком у майбутньому — і ревʼю могло б його пропустити.
 * Тут ми скануємо вихідний код і падаємо в CI, щойно небезпечний патерн
 * повертається. Дозволено рівно те, що перевірено як безпечне: Prisma raw
 * лише через теговий шаблон (prepared statement), а *Unsafe — лише з
 * константним рядком-літералом без інтерполяції (наші SAVEPOINT).
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (extname(full) !== '.ts') continue;
    if (full.includes('.test.')) continue;       // тести можуть мокати $queryRaw
    if (full.endsWith('.before')) continue;        // робочі знімки, не код
    out.push(full);
  }
  return out;
}

/** Текст аргументів виклику від `(` до парного `)` (простий балансувальник). */
function callArgs(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return text.slice(openParen + 1, i); }
  }
  return text.slice(openParen + 1);
}

const files = sourceFiles(SRC);

describe('статичний запобіжник безпеки', () => {
  it('сканує непорожнє дерево вихідників', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('$queryRawUnsafe/$executeRawUnsafe — лише з константним літералом без інтерполяції', () => {
    const offenders: string[] = [];
    const re = /\$(?:queryRaw|executeRaw)Unsafe\s*\(/g;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const args = callArgs(text, m.index + m[0].length - 1);
        // Перший аргумент (SQL). Інтерполяція = теговий/звичайний шаблон,
        // конкатенація або явна підстановка — усе це робить запит динамічним.
        const dynamic = args.includes('`') || args.includes('${') || /\+\s*[A-Za-z_$]/.test(args);
        if (dynamic) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${file.replace(SRC, 'src')}:${line} → ${args.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders, `Небезпечний динамічний raw SQL:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('немає raw-SQL через конкатенацію рядків у $queryRaw/$executeRaw', () => {
    // Теговий шаблон ($queryRaw`...`) безпечний. Виклик у дужках
    // ($queryRaw(`...`)) — ні: так Prisma трактує рядок як сирий SQL.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const re = /\$(?:queryRaw|executeRaw)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${file.replace(SRC, 'src')}:${line}`);
      }
    }
    expect(offenders, `$queryRaw/$executeRaw має викликатись як теговий шаблон, не з дужками:\n${offenders.join('\n')}`).toEqual([]);
  });
});
