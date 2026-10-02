/**
 * @fileoverview Time dimension columns that may be DATE rather than TIMESTAMP.
 *
 * Cube has a single `time` type; DB2 has DATE and TIMESTAMP. DB2 for z/OS
 * (at V10R1) does not compare the two, so a time filter on a DATE column,
 * `COL >= CAST(? AS TIMESTAMP)`, fails there with SQLCODE -401. Wrapping the
 * column in TIMESTAMP() makes it comparable, but a function on a column also
 * stops DB2 from matching an index on it, and the model can't tell the
 * dialect which columns are DATE.
 *
 * So the dialect marks the time dimension columns it compares, and the driver
 * sends them bare. Only if DB2 answers -401 does it send the statement again
 * with every marked column wrapped in TIMESTAMP(), and it remembers that for
 * the same statement. TIMESTAMP columns keep index-friendly predicates; DATE
 * columns cost one failed prepare per statement shape. LUW compares DATE with
 * TIMESTAMP itself and never needs the retry.
 */

const OPEN = '/*db2:ts(*/';
const CLOSE = '/*)db2:ts*/';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** An innermost marked operand: no opening marker between OPEN and CLOSE. */
const INNERMOST = new RegExp(`${escape(OPEN)}((?:(?!${escape(OPEN)})[\\s\\S])*?)${escape(CLOSE)}`, 'g');

/** Marks a time dimension column that may be DATE (see the file overview). */
export function markTimestampOperand(sql: string): string {
  return `${OPEN}${sql}${CLOSE}`;
}

export function hasTimestampOperands(sql: string): boolean {
  return sql.includes(OPEN);
}

function replaceMarked(sql: string, replace: (operand: string) => string): string {
  let out = sql;
  let previous;
  do {
    previous = out;
    out = out.replace(INNERMOST, (_, operand: string) => replace(operand));
  } while (out !== previous);
  return out;
}

/** The statement as DB2 should see it first: marked columns bare. */
export function unmarkTimestampOperands(sql: string): string {
  return replaceMarked(sql, operand => operand);
}

/** The statement for DATE columns: marked columns wrapped in TIMESTAMP(). */
export function castTimestampOperands(sql: string): string {
  return replaceMarked(sql, operand => `TIMESTAMP(${operand})`);
}

/**
 * Tesseract filter templates for the comparison operators, which it also uses
 * for number filters: only operands compared with a timestamp are marked.
 */
export function markedComparisonTemplate(operator: string): string {
  return `{% if 'AS TIMESTAMP)' in param %}${OPEN}{{ column }}${CLOSE}{% else %}{{ column }}{% endif %} ${operator} {{ param }}`;
}

export function markedColumnTemplate(template: string): string {
  return template.replace(/\{\{ column \}\}/g, `${OPEN}{{ column }}${CLOSE}`);
}
