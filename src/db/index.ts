import { drizzle, DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Creates a type-safe Drizzle ORM client connected to Cloudflare D1.
 * Passes the complete schema so that relational queries (`db.query.*`) are fully typed.
 * 
 * @param d1 - The Cloudflare D1 database binding (e.g. `c.env.DB`)
 * @returns Fully typed Drizzle D1 database instance
 */
export function createDb(d1: D1Database): DrizzleD1Database<typeof schema> {
  return drizzle(d1, { schema });
}

export type Database = DrizzleD1Database<typeof schema>;
