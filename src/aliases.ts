/**
 * @fileoverview Keeps generated column aliases within DB2 for z/OS's 30-byte
 * column-name limit.
 *
 * z/OS truncates result column names to 30 bytes (so a longer alias comes
 * back under a different key) and rejects longer column names in DDL. Cube
 * builds aliases like "orders__a_measure_with_a_long_name", and the Tesseract
 * planner builds them in Rust, out of reach of the dialect's aliasName(). So
 * the driver rewrites the SQL it executes: every delimited identifier longer
 * than 30 bytes becomes a deterministic 30-byte name, except in positions that
 * name a table or an index (those may be 128 bytes). The rewrite is the same
 * for every statement, so a pre-aggregation table created with shortened
 * column names is later read with the same shortened names. Result columns
 * are renamed back before rows reach Cube.
 */

import { createHash } from 'crypto';

export const MAX_COLUMN_NAME_BYTES = 30;
const HASH_LENGTH = 8;

/** Keywords after which a delimited identifier names a table or an index. */
const OBJECT_NAME_KEYWORDS = new Set(['FROM', 'JOIN', 'INTO', 'TABLE', 'UPDATE', 'INDEX', 'EXISTS']);

export interface ShortenedSql {
  sql: string;
  /** Short name → original name, for renaming result columns. Empty when nothing changed. */
  restore: Map<string, string>;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Deterministic 30-byte replacement: a readable prefix plus a hash of the
 * full name, so distinct long names never collide in practice.
 */
export function shortIdentifier(name: string): string {
  const hash = createHash('sha1').update(name).digest('hex').slice(0, HASH_LENGTH);
  let prefix = name.slice(0, MAX_COLUMN_NAME_BYTES - HASH_LENGTH - 1);
  while (byteLength(prefix) > MAX_COLUMN_NAME_BYTES - HASH_LENGTH - 1) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}_${hash}`;
}

type Token =
  | { kind: 'quoted'; text: string; value: string }
  | { kind: 'string'; text: string }
  | { kind: 'word'; text: string }
  | { kind: 'other'; text: string };

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '"' || ch === '\'') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const text = sql.slice(i, j + 1);
      tokens.push(ch === '"'
        ? { kind: 'quoted', text, value: text.slice(1, -1).replace(/""/g, '"') }
        : { kind: 'string', text });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$#@]/.test(sql[j])) j++;
      tokens.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: 'other', text: ch });
      i++;
    }
  }
  return tokens;
}

/**
 * True when the delimited identifier at `index` names a table or index:
 * `FROM "t"`, `FROM "schema"."t"`, `CREATE INDEX "i" ON "s"."t"`, ...
 */
function isObjectName(tokens: Token[], index: number, isCreateIndex: boolean): boolean {
  let k = index - 1;
  const skipSpace = () => {
    while (k >= 0 && tokens[k].kind === 'other' && /\s/.test(tokens[k].text)) k--;
  };
  skipSpace();
  // A qualifier: "schema"."table" or schema."table"
  if (k >= 0 && tokens[k].text === '.') {
    k--;
    skipSpace();
    if (k >= 0 && (tokens[k].kind === 'quoted' || tokens[k].kind === 'word')) {
      k--;
      skipSpace();
    }
  }
  if (k < 0 || tokens[k].kind !== 'word') {
    return false;
  }
  const keyword = tokens[k].text.toUpperCase();
  return OBJECT_NAME_KEYWORDS.has(keyword) || (isCreateIndex && keyword === 'ON');
}

/**
 * Rewrites delimited identifiers longer than 30 bytes, outside table and
 * index name positions, to their short form.
 */
export function shortenLongIdentifiers(sql: string): ShortenedSql {
  const restore = new Map<string, string>();
  if (!sql.includes('"')) {
    return { sql, restore };
  }

  const tokens = tokenize(sql);
  const isCreateIndex = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(sql);
  let changed = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'quoted' || byteLength(token.value) <= MAX_COLUMN_NAME_BYTES) {
      continue;
    }
    if (isObjectName(tokens, i, isCreateIndex)) {
      continue;
    }
    const short = shortIdentifier(token.value);
    restore.set(short, token.value);
    token.text = `"${short.replace(/"/g, '""')}"`;
    changed = true;
  }

  return { sql: changed ? tokens.map(t => t.text).join('') : sql, restore };
}

/**
 * Returns a function renaming shortened result columns back to their
 * original names, or null when no column was shortened.
 */
export function buildRowRenamer(restore: Map<string, string>): ((row: Record<string, unknown>) => Record<string, unknown>) | null {
  if (!restore.size) {
    return null;
  }
  return (row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      out[restore.get(key) ?? key] = row[key];
    }
    return out;
  };
}
