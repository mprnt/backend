import { Database, db } from '../config/database';

export interface LeadInput {
  name: string;
  email: string;
  message: string;
  phone?: string;
  company?: string;
  source?: string;
  clientIp?: string;
  userAgent?: string;
}

export interface Lead {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string;
  source: string;
  createdAt: Date;
}

interface LeadRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  message: string;
  source: string;
  created_at: Date;
}

const toLead = (r: LeadRow): Lead => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  company: r.company,
  message: r.message,
  source: r.source,
  createdAt: r.created_at,
});

/** Contact-form leads from MPrint Web. */
export class LeadService {
  constructor(private database: Database = db) {}

  async create(input: LeadInput): Promise<{ id: string; createdAt: Date }> {
    const result = await this.database.query<{ id: string; created_at: Date }>(
      `INSERT INTO leads (name, email, phone, company, message, source, client_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)
       RETURNING id, created_at`,
      [
        input.name,
        input.email,
        input.phone ?? null,
        input.company ?? null,
        input.message,
        input.source ?? 'web',
        input.clientIp ?? null,
        input.userAgent ?? null,
      ]
    );
    return { id: result.rows[0].id, createdAt: result.rows[0].created_at };
  }

  async list(limit: number, offset: number): Promise<{ leads: Lead[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.database.query<LeadRow>(
        `SELECT id, name, email, phone, company, message, source, created_at
         FROM leads ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      this.database.query<{ total: string }>(`SELECT COUNT(*) AS total FROM leads`),
    ]);
    return { leads: rows.rows.map(toLead), total: parseInt(count.rows[0].total, 10) };
  }
}

export const leadService = new LeadService();
