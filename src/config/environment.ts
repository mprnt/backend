import dotenv from 'dotenv';

dotenv.config();

interface Environment {
  node_env: string;
  port: number;
  api_version: string;
  database: {
    url: string;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    pool_min: number;
    pool_max: number;
  };
  jwt: {
    secret: string;
    access_token_expiry: string;
    refresh_token_expiry: string;
  };
  security: {
    bcrypt_rounds: number;
    rate_limit_window_ms: number;
    rate_limit_max_requests: number;
    session_timeout_minutes: number;
  };
  cors: {
    origin: string[];
    credentials: boolean;
  };
  storage: {
    type: string;
    aws_region: string;
    aws_access_key_id: string;
    aws_secret_access_key: string;
    s3_bucket_name: string;
    s3_endpoint?: string;
  };
  upload: {
    max_file_size_mb: number;
    allowed_file_types: string[];
    upload_path: string;
  };
  payment: {
    gateway: string;
    razorpay_key_id: string;
    razorpay_key_secret: string;
    razorpay_webhook_secret: string;
  };
  pricing: {
    price_per_page_bw: number;
    price_per_page_color: number;
  };
  logging: {
    level: string;
    file_path: string;
    pretty_logs: boolean;
  };
  websocket: {
    port: number;
    path: string;
  };
  admin: {
    access_token_ttl: string;
    access_token_ttl_seconds: number;
    refresh_token_ttl_seconds: number;
    login_rate_limit_max: number;
    proxy_secret: string;
  };
  printer: {
    provisioning_token: string;
    job_lease_seconds: number;
    document_url_ttl_seconds: number;
    heartbeat_timeout_seconds: number;
  };
  thresholds: {
    inactive_shop_days: number;
    refund_candidate_minutes: number;
    printer_offline_warn_minutes: number;
  };
}

const env: Environment = {
  node_env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  api_version: process.env.API_VERSION || 'v1',
  database: {
    url: process.env.DATABASE_URL || '',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'mprnt',
    user: process.env.DB_USER || 'mprnt_user',
    password: process.env.DB_PASSWORD || '',
    pool_min: parseInt(process.env.DB_POOL_MIN || '2', 10),
    pool_max: parseInt(process.env.DB_POOL_MAX || '20', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'change_this_secret',
    access_token_expiry: process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m',
    refresh_token_expiry: process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d',
  },
  security: {
    bcrypt_rounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
    rate_limit_window_ms: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rate_limit_max_requests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
    session_timeout_minutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES || '15', 10),
  },
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(','),
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },
  storage: {
    type: process.env.STORAGE_TYPE || 's3',
    aws_region: process.env.AWS_REGION || 'us-east-1',
    aws_access_key_id: process.env.AWS_ACCESS_KEY_ID || '',
    aws_secret_access_key: process.env.AWS_SECRET_ACCESS_KEY || '',
    s3_bucket_name: process.env.S3_BUCKET_NAME || 'mprnt-documents',
    s3_endpoint: process.env.S3_ENDPOINT,
  },
  upload: {
    max_file_size_mb: parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10),
    allowed_file_types: (
      process.env.ALLOWED_FILE_TYPES || 'application/pdf,image/png,image/jpeg'
    ).split(','),
    upload_path: process.env.UPLOAD_PATH || '/tmp/uploads',
  },
  payment: {
    gateway: process.env.PAYMENT_GATEWAY || 'razorpay',
    razorpay_key_id: process.env.RAZORPAY_KEY_ID || '',
    razorpay_key_secret: process.env.RAZORPAY_KEY_SECRET || '',
    razorpay_webhook_secret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  pricing: {
    price_per_page_bw: parseFloat(process.env.PRICE_PER_PAGE_BW || '2.00'),
    price_per_page_color: parseFloat(process.env.PRICE_PER_PAGE_COLOR || '5.00'),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file_path: process.env.LOG_FILE_PATH || 'logs/app.log',
    pretty_logs: process.env.PRETTY_LOGS === 'true',
  },
  websocket: {
    port: parseInt(process.env.WS_PORT || '3001', 10),
    path: process.env.WS_PATH || '/api/v1/ws',
  },
  admin: {
    // Short-lived so a leaked access token has a small blast radius.
    access_token_ttl: process.env.ADMIN_ACCESS_TOKEN_TTL || '15m',
    access_token_ttl_seconds: parseInt(process.env.ADMIN_ACCESS_TOKEN_TTL_SECONDS || '900', 10),
    // Refresh tokens are revocable, so they can safely live much longer.
    refresh_token_ttl_seconds: parseInt(
      process.env.ADMIN_REFRESH_TOKEN_TTL_SECONDS || String(7 * 24 * 3600),
      10
    ),
    login_rate_limit_max: parseInt(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX || '10', 10),
    // Shared with the admin dashboard so it can relay each admin's real IP.
    // Unset = the dashboard's own IP is recorded for every admin. See
    // middleware/trustedProxy.ts.
    proxy_secret: process.env.ADMIN_PROXY_SECRET || '',
  },
  printer: {
    // Shared secret a Raspberry Pi presents once to enroll itself and receive its own API key.
    provisioning_token: process.env.PRINTER_PROVISIONING_TOKEN || '',
    // How long a printer may hold a claimed job before the reaper requeues it.
    job_lease_seconds: parseInt(process.env.PRINTER_JOB_LEASE_SECONDS || '900', 10),
    // Lifetime of the pre-signed S3 URL handed to the Pi. Short by design.
    document_url_ttl_seconds: parseInt(process.env.PRINTER_DOCUMENT_URL_TTL_SECONDS || '900', 10),
    // No heartbeat for this long => printer marked offline and stops receiving jobs.
    heartbeat_timeout_seconds: parseInt(process.env.PRINTER_HEARTBEAT_TIMEOUT_SECONDS || '180', 10),
  },
  // Operational thresholds for the dashboards. Defaults are deliberately
  // conservative starting points, meant to be tuned once real traffic exists.
  thresholds: {
    // A shop with no paid job for this many days is flagged inactive — the
    // earliest signal of churn or a kiosk that has quietly stopped working.
    inactive_shop_days: parseInt(process.env.INACTIVE_SHOP_DAYS || '3', 10),
    // A paid job still unprinted after this long is flagged as a refund candidate.
    refund_candidate_minutes: parseInt(process.env.REFUND_CANDIDATE_MINUTES || '60', 10),
    // A printer silent for this long is highlighted in the fleet view.
    printer_offline_warn_minutes: parseInt(process.env.PRINTER_OFFLINE_WARN_MINUTES || '15', 10),
  },
};

if (env.node_env === 'production') {
  const missing: string[] = [];
  if (!env.printer.provisioning_token) missing.push('PRINTER_PROVISIONING_TOKEN');
  if (env.jwt.secret === 'change_this_secret') missing.push('JWT_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start in production without: ${missing.join(', ')}. ` +
        'These guard the printer enrollment and admin endpoints.'
    );
  }
}

export default env;
