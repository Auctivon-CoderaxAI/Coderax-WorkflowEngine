import { emptyBudgetWindow, type BudgetWindow, type BudgetWindowStore } from '../models/budget.js';
import { isDuplicateKey, type MongoCollectionLike } from './mongo.js';

/** One unique row per owner and UTC day. A revision CAS makes admission,
 * settlement and release atomic across replicas, including token holds.
 * Only active reservations are retained; completed IDs cannot refund twice.
 */
export function createMongoBudgetStore(collection: MongoCollectionLike): BudgetWindowStore {
  type Row = { key: string; revision: number; window: BudgetWindow };
  async function read(key: string): Promise<Row | null> {
    return await collection.findOne({ key }) as unknown as Row | null;
  }
  return {
    read: async (key) => structuredClone((await read(key))?.window ?? emptyBudgetWindow()),
    update: async (key, change) => {
      for (let attempt = 0; attempt < 128; attempt += 1) {
        const row = await read(key);
        const window = structuredClone(row?.window ?? emptyBudgetWindow());
        const result = change(window);
        if (!row) {
          try {
            await collection.insertOne({ key, revision: 1, window });
            return result;
          } catch (error) {
            if (!isDuplicateKey(error)) throw error;
          }
        } else {
          const applied = await collection.findOneAndUpdate(
            { key, revision: row.revision },
            { $set: { window }, $inc: { revision: 1 } },
            { returnDocument: 'after', includeResultMetadata: false },
          );
          if (applied) return result;
        }
      }
      throw new Error('Budget window contention: request refused without a quota grant');
    },
  };
}

export async function ensureBudgetIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ key: 1 }, { unique: true, name: 'budget_window' });
}
