// Database table interfaces matching the schema

export interface Kiosk {
  id: string;
  kiosk_id: string;
  location: string;
  raspberry_pi_id: string | null;
  status: 'active' | 'maintenance' | 'offline';
  printer_status: Record<string, unknown> | null;
  ip_address: string | null;
  last_heartbeat: Date | null;
  capabilities: {
    color?: boolean;
    duplex?: boolean;
    paper_sizes?: string[];
  } | null;
  created_at: Date;
  updated_at: Date;
}

export interface PrintSession {
  id: string;
  session_id: string;
  kiosk_id: string | null;
  status: 'draft' | 'pending' | 'processing' | 'complete' | 'error' | 'expired';
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  client_ip: string | null;
  user_agent: string | null;
}

export interface Document {
  id: string;
  session_id: string;
  original_filename: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  page_count: number;
  processed: boolean;
  processed_path: string | null;
  uploaded_at: Date;
  processed_at: Date | null;
}

export interface PrintJob {
  id: string;
  session_id: string | null;
  document_id: string | null;
  kiosk_id: string | null;
  color_mode: 'bw' | 'color';
  page_range: string;
  custom_range: string | null;
  copies: number;
  orientation: 'portrait' | 'landscape';
  paper_size: 'a4' | 'letter';
  print_sides: 'single' | 'double';
  base_price_per_page: number;
  total_pages: number;
  total_amount: number;
  status: 'pending' | 'queued' | 'printing' | 'completed' | 'failed' | 'cancelled';
  error_message: string | null;
  retry_count: number;
  created_at: Date;
  queued_at: Date | null;
  started_printing_at: Date | null;
  completed_at: Date | null;
  printed_pages: number;
  print_duration_seconds: number | null;
}

export interface Payment {
  id: string;
  print_job_id: string | null;
  session_id: string | null;
  amount: number;
  payment_method: 'upi' | 'card' | 'wallet';
  transaction_id: string;
  gateway_response: Record<string, unknown> | null;
  payment_gateway: string | null;
  status: 'pending' | 'processing' | 'success' | 'failed' | 'refunded';
  initiated_at: Date;
  completed_at: Date | null;
  reconciled: boolean;
  reconciled_at: Date | null;
}

export interface AnalyticsEvent {
  id: number;
  event_type: string;
  kiosk_id: string | null;
  session_id: string | null;
  event_data: Record<string, unknown> | null;
  occurred_at: Date;
}

export interface DailyStats {
  id: number;
  date: Date;
  kiosk_id: string | null;
  total_sessions: number;
  completed_sessions: number;
  total_prints: number;
  total_pages: number;
  total_revenue: number;
  bw_pages: number;
  color_pages: number;
  avg_session_duration_seconds: number | null;
  failed_prints: number;
  last_updated_at: Date;
}

export interface AdminUser {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  role: 'admin' | 'manager' | 'viewer';
  last_login_at: Date | null;
  created_at: Date;
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
}

export interface AuditLog {
  id: number;
  admin_user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
  created_at: Date;
}

// Insert/Update types (omit auto-generated fields)
export type KioskInsert = Omit<Kiosk, 'id' | 'created_at' | 'updated_at'> &
  Partial<Pick<Kiosk, 'id'>>;

export type PrintSessionInsert = Omit<PrintSession, 'id' | 'created_at'> &
  Partial<Pick<PrintSession, 'id'>>;

export type DocumentInsert = Omit<Document, 'id' | 'uploaded_at'> & Partial<Pick<Document, 'id'>>;

export type PrintJobInsert = Omit<PrintJob, 'id' | 'created_at'> & Partial<Pick<PrintJob, 'id'>>;

export type PaymentInsert = Omit<Payment, 'id' | 'initiated_at'> & Partial<Pick<Payment, 'id'>>;

export type AnalyticsEventInsert = Omit<AnalyticsEvent, 'id' | 'occurred_at'>;

export type DailyStatsInsert = Omit<DailyStats, 'id' | 'last_updated_at'>;

export type AdminUserInsert = Omit<AdminUser, 'id' | 'created_at'> & Partial<Pick<AdminUser, 'id'>>;

export type AuditLogInsert = Omit<AuditLog, 'id' | 'created_at'>;

// Update types (all fields optional except id)
export type KioskUpdate = Partial<Omit<Kiosk, 'id'>>;
export type PrintSessionUpdate = Partial<Omit<PrintSession, 'id'>>;
export type DocumentUpdate = Partial<Omit<Document, 'id'>>;
export type PrintJobUpdate = Partial<Omit<PrintJob, 'id'>>;
export type PaymentUpdate = Partial<Omit<Payment, 'id'>>;
export type DailyStatsUpdate = Partial<Omit<DailyStats, 'id'>>;
export type AdminUserUpdate = Partial<Omit<AdminUser, 'id'>>;
