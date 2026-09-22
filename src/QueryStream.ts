/**
 * @fileoverview Readable stream over an ibm_db result set, with backpressure.
 */

import { Readable } from 'stream';
import { getEnv } from '@cubejs-backend/shared';

import { Db2Result, keepLoopAwake } from './ibm';
import { FETCH_BATCH_SIZE, fetchBatch } from './rows';

export class QueryStream extends Readable {
  private result: Db2Result | null;

  public constructor(
    result: Db2Result,
    private readonly transform: ((row: Record<string, unknown>) => void) | null,
    private readonly rename: ((row: Record<string, unknown>) => Record<string, unknown>) | null,
    private readonly onClose: (error?: Error | null) => Promise<void>,
    highWaterMark?: number
  ) {
    super({
      objectMode: true,
      highWaterMark: highWaterMark || getEnv('dbQueryStreamHighWaterMark'),
    });
    this.result = result;
  }

  /**
   * Pushes one synchronous batch of rows (sized to what the consumer asked
   * for) and stops as soon as push() signals backpressure. Readable calls
   * _read again, on a later tick, once the consumer wants more.
   */
  public _read(size: number): void {
    if (!this.result) {
      return;
    }

    let batch: { rows: Record<string, unknown>[]; done: boolean };
    try {
      batch = fetchBatch(this.result, Math.max(1, Math.min(size || FETCH_BATCH_SIZE, FETCH_BATCH_SIZE)));
    } catch (e) {
      this.destroy(e as Error);
      return;
    }

    for (const row of batch.rows) {
      if (this.transform) {
        this.transform(row);
      }
      this.push(this.rename ? this.rename(row) : row);
    }

    if (batch.done) {
      this.finish();
    }
  }

  public _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const result = this.result;
    this.result = null;
    if (!result) {
      callback(error);
      return;
    }
    closeQuietly(result)
      .then(() => this.onClose(error || new Error('Stream destroyed before the result set was exhausted')))
      .then(() => callback(error), () => callback(error));
  }

  private finish(): void {
    const result = this.result;
    this.result = null;
    if (!result) {
      return;
    }
    closeQuietly(result)
      .then(() => this.onClose(null))
      .then(() => this.push(null), (e) => this.destroy(e));
  }
}

export async function closeQuietly(result: Db2Result): Promise<void> {
  try {
    await keepLoopAwake(() => result.close());
  } catch {
    // The statement handle is already gone; nothing else to release.
  }
}
