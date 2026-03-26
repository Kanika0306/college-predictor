import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

let dbPromise = null;

export const pool = {
  query: async (text, params) => {
    if (!dbPromise) {
      dbPromise = open({
        filename: path.join(process.cwd(), 'test_futures.db'),
        driver: sqlite3.Database
      });
    }
    const db = await dbPromise;

    // Convert PostgreSQL syntax to SQLite syntax
    let sqliteText = text.replace(/\$\d+/g, '?');
    sqliteText = sqliteText.replace(/ILIKE/gi, 'LIKE');

    // Execute the query
    const rows = await db.all(sqliteText, params || []);
    return { rows };
  }
};

export default pool;
