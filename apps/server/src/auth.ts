// Accounts: scrypt password hashes and opaque session tokens.
import crypto from 'node:crypto';
import type { DB } from './db.js';

const USERNAME = /^[A-Za-z0-9_]{3,16}$/;

function hash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export type AuthResult = { ok: true; token: string; accountId: number; username: string } | { ok: false; error: string };

export function register(db: DB, username: string, password: string, now: number): AuthResult {
  if (!USERNAME.test(username)) return { ok: false, error: 'Username must be 3-16 letters, digits or _.' };
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) return { ok: false, error: 'Password must be at least 6 characters.' };
  if (db.prepare(`SELECT 1 FROM accounts WHERE username = ?`).get(username)) return { ok: false, error: 'That username is taken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const id = Number(db.prepare(`INSERT INTO accounts (username, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?)`)
    .run(username, hash(password, salt), salt, now).lastInsertRowid);
  return { ok: true, token: newSession(db, id, now), accountId: id, username };
}

export function login(db: DB, username: string, password: string, now: number): AuthResult {
  const row = db.prepare(`SELECT id, username, pw_hash, pw_salt FROM accounts WHERE username = ?`).get(username) as
    { id: number; username: string; pw_hash: string; pw_salt: string } | undefined;
  const fail: AuthResult = { ok: false, error: 'Wrong username or password.' };
  if (!row || typeof password !== 'string') return fail;
  const a = Buffer.from(hash(password, row.pw_salt), 'hex'), b = Buffer.from(row.pw_hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail;
  return { ok: true, token: newSession(db, row.id, now), accountId: row.id, username: row.username };
}

export function sessionAccount(db: DB, token: string): { id: number; username: string } | null {
  if (typeof token !== 'string' || token.length !== 64) return null;
  return (db.prepare(`SELECT a.id, a.username FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`).get(token) as
    { id: number; username: string } | undefined) ?? null;
}

export function logout(db: DB, token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

function newSession(db: DB, accountId: number, now: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)`).run(token, accountId, now);
  return token;
}
