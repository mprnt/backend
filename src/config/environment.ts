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
  redis: {
    url: string;
    host: string;
    port: number;
    password: string;
    db: number;
    tls: boolean;
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
  printer: {
    provisioning_token: string;
    job_lease_seconds: number;
    document_url_ttl_seconds: number;
    heartbeat_timeout_seconds: number;
  };
}

function parseRedisFromEnv(): Environment['redis'] {
  const url = process.env.REDIS_URL || process.env.QUEUE_REDIS_URL || 'redis://localhost:6379';
  const fallbackHost = process.env.REDIS_HOST || 'localhost';
  const fallbackPort = parseInt(process.env.REDIS_PORT || '6379', 10);
  const fallbackPassword = process.env.REDIS_PASSWORD || '';
  const db = parseInt(process.env.REDIS_DB || '0', 10);

  try {
    const parsed = new URL(url);
    const host = parsed.hostname || fallbackHost;
    const port = parsed.port ? parseInt(parsed.port, 10) : fallbackPort;
    const password = parsed.password ? decodeURIComponent(parsed.password) : fallbackPassword;

    return {
      url,
      host,
      port,
      password,
      db,
      tls: parsed.protocol === 'rediss:',
    };
  } catch {
    return {
      url,
      host: fallbackHost,
      port: fallbackPort,
      password: fallbackPassword,
      db,
      tls: false,
    };
  }
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
  redis: parseRedisFromEnv(),
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
