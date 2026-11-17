import 'server-only';
import mysql, { Pool } from 'mysql2/promise';

/** Kết nối MariaDB (cùng database với tool mt5_history). */
const g = globalThis as unknown as { __backtestPool?: Pool };

function createPool(): Pool {
  if (!process.env.DB_USER || !process.env.DB_NAME) {
    throw new Error(`Chưa đọc được DB_USER / DB_NAME từ .env (thư mục chạy: ${process.cwd()}). Kiểm tra file .env rồi chạy lại app.`);
  }
  return mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: Number(process.env.DB_POOL || 5),
    dateStrings: ['DATE'],
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    charset: 'utf8mb4',
  });
}

export function pool(): Pool {
  if (!g.__backtestPool) g.__backtestPool = createPool();
  return g.__backtestPool;
}

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool().query(sql, params);
  return rows as T[];
}

export async function one<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function exec(sql: string, params: any[] = []): Promise<{ insertId: number; affectedRows: number }> {
  const [res]: any = await pool().query(sql, params);
  return { insertId: Number(res.insertId), affectedRows: Number(res.affectedRows) };
}
