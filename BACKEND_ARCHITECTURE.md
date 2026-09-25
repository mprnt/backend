# MPrnt Backend Architecture

## Executive Summary

This document outlines the backend architecture for the MPrnt kiosk printing system, designed to handle:
1. **QR-based printing workflow** - User sessions, document processing, payments, and print job management
2. **Raspberry Pi printer integration** - Direct hardware communication for print execution
3. **Admin dashboard** - Analytics, transaction monitoring, and system management
4. **Scalability** - Designed for multi-kiosk deployment with future growth

## Architecture Decision: Unified vs. Separate Backend

### ✅ Recommended: **Unified Backend Architecture**

**Rationale:**
- **Shared Data Model**: Both kiosk and admin access the same transaction, session, and kiosk data
- **Simplified Deployment**: Single codebase, easier maintenance, and consistent business logic
- **Cost Efficiency**: One server infrastructure, one database, shared monitoring
- **Real-time Sync**: Admin dashboard automatically reflects kiosk transactions without data synchronization
- **Security**: Single authentication/authorization layer, easier to audit
- **Scalability Path**: Can add microservices later if specific components need independent scaling

**Alternative (Not Recommended):**
- Separate backends would require data synchronization, duplicate business logic, and increased operational complexity
- Only justifiable if admin and kiosk have completely different scaling requirements (unlikely at prototype stage)

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Load Balancer (Nginx)                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼───────┐    ┌──────▼──────┐     ┌──────▼──────┐
│  Node.js API  │    │ Node.js API │     │ Node.js API │
│   Instance 1  │    │  Instance 2 │     │  Instance N │
└───────┬───────┘    └──────┬──────┘     └──────┬──────┘
        │                   │                    │
        └───────────────────┼────────────────────┘
                            │
        ┌───────────────────┼───────────────────────────┐
        │                   │                           │
┌───────▼───────┐   ┌───────▼────────┐      ┌─────────▼────────┐
│   PostgreSQL  │   │  Redis Cache   │      │  AWS S3/MinIO    │
│   (Primary)   │   │  - Sessions    │      │  - Documents     │
│               │   │  - Rate Limit  │      │  - Receipts      │
└───────────────┘   └────────────────┘      └──────────────────┘
                                                      
┌─────────────────────────────────────────────────────────────────┐
│                   Message Queue (RabbitMQ/Bull)                  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
┌───────▼────────┐ ┌──────▼──────┐ ┌───────▼────────┐
│ Print Worker 1 │ │Print Worker 2│ │Print Worker N  │
│ (Per Pi/Kiosk) │ │(Per Pi/Kiosk)│ │(Per Pi/Kiosk)  │
└───────┬────────┘ └──────┬───────┘ └───────┬────────┘
        │                 │                 │
┌───────▼────────┐ ┌──────▼───────┐ ┌───────▼────────┐
│ Raspberry Pi 1 │ │Raspberry Pi 2│ │Raspberry Pi N  │
│   (CUPS/USB)   │ │  (CUPS/USB)  │ │  (CUPS/USB)   │
└────────────────┘ └──────────────┘ └────────────────┘
```

---

## Technology Stack

### Core Backend
- **Runtime**: Node.js 20+ with TypeScript
- **Framework**: Express.js or Fastify (for performance)
- **API Style**: REST (with WebSocket for real-time updates)

### Database & Storage
- **Primary Database**: PostgreSQL 16+ (ACID compliance for transactions)
- **Cache Layer**: Redis 7+ (sessions, rate limiting, job queues)
- **File Storage**: AWS S3 / MinIO (self-hosted alternative)
- **Search (Future)**: Elasticsearch (for admin analytics)

### Message Queue & Background Jobs
- **Queue System**: Bull (Redis-based) or RabbitMQ
- **Job Types**: 
  - Print job processing
  - Document conversion (PDF → printer-ready format)
  - Payment reconciliation
  - Analytics aggregation

### Raspberry Pi Integration
- **Print Server**: CUPS (Common UNIX Printing System)
- **Communication**: 
  - **Option 1**: WebSocket connection (Pi pulls jobs from backend)
  - **Option 2**: MQTT broker (pub/sub pattern)
  - **Option 3**: HTTP polling with long-polling (simpler, less real-time)
- **Document Processing**: Ghostscript, ImageMagick (on Pi or backend)

### Monitoring & DevOps
- **Logging**: Winston / Pino → Elasticsearch → Kibana
- **APM**: New Relic / Datadog / Self-hosted Grafana
- **Error Tracking**: Sentry
- **Metrics**: Prometheus + Grafana

---

## Database Schema

### Core Tables

```sql
-- Kiosks Table
CREATE TABLE kiosks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kiosk_id VARCHAR(10) UNIQUE NOT NULL, -- e.g., 'M001'
    location VARCHAR(255) NOT NULL,
    raspberry_pi_id VARCHAR(50) UNIQUE,
    status VARCHAR(20) DEFAULT 'active', -- active, maintenance, offline
    printer_status JSONB, -- last known printer state
    ip_address INET,
    last_heartbeat TIMESTAMP,
    capabilities JSONB, -- color, duplex, paper_sizes
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Print Sessions Table
CREATE TABLE print_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(20) UNIQUE NOT NULL, -- e.g., 'S1726999999999'
    kiosk_id UUID REFERENCES kiosks(id),
    status VARCHAR(20) DEFAULT 'draft', -- draft, pending, processing, complete, error, expired
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '15 minutes'),
    completed_at TIMESTAMP,
    
    -- Session metadata
    client_ip INET,
    user_agent TEXT,
    
    CONSTRAINT session_timeout CHECK (expires_at > created_at)
);

-- Documents Table
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES print_sessions(id) ON DELETE CASCADE,
    
    -- File information
    original_filename VARCHAR(255) NOT NULL,
    file_size BIGINT NOT NULL, -- bytes
    mime_type VARCHAR(100) NOT NULL,
    storage_path TEXT NOT NULL, -- S3/MinIO path
    
    -- Document properties
    page_count INTEGER NOT NULL,
    processed BOOLEAN DEFAULT false,
    processed_path TEXT, -- path to print-ready file
    
    -- Metadata
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

-- Print Jobs Table (Core transaction entity)
CREATE TABLE print_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES print_sessions(id),
    document_id UUID REFERENCES documents(id),
    kiosk_id UUID REFERENCES kiosks(id),
    
    -- Print settings
    color_mode VARCHAR(10) NOT NULL, -- 'bw', 'color'
    page_range VARCHAR(50) DEFAULT 'all', -- 'all', 'custom', 'current'
    custom_range TEXT, -- e.g., '1-5,8,10-12'
    copies INTEGER DEFAULT 1 CHECK (copies > 0 AND copies <= 100),
    orientation VARCHAR(10) DEFAULT 'portrait', -- portrait, landscape
    paper_size VARCHAR(10) DEFAULT 'a4', -- a4, letter
    print_sides VARCHAR(10) DEFAULT 'single', -- single, double
    
    -- Pricing
    base_price_per_page DECIMAL(10,2) NOT NULL,
    total_pages INTEGER NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending', -- pending, queued, printing, completed, failed, cancelled
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    queued_at TIMESTAMP,
    started_printing_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Audit
    printed_pages INTEGER DEFAULT 0,
    print_duration_seconds INTEGER
);

-- Payments Table
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    print_job_id UUID REFERENCES print_jobs(id),
    session_id UUID REFERENCES print_sessions(id),
    
    -- Payment details
    amount DECIMAL(10,2) NOT NULL,
    payment_method VARCHAR(20) NOT NULL, -- upi, card, wallet
    transaction_id VARCHAR(100) UNIQUE NOT NULL,
    
    -- Payment gateway info
    gateway_response JSONB,
    payment_gateway VARCHAR(50), -- razorpay, paytm, stripe
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending', -- pending, processing, success, failed, refunded
    
    -- Timestamps
    initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Reconciliation
    reconciled BOOLEAN DEFAULT false,
    reconciled_at TIMESTAMP
);

-- Analytics Events Table (for admin dashboard)
CREATE TABLE analytics_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL, -- session_start, upload, payment, print_complete, error
    kiosk_id UUID REFERENCES kiosks(id),
    session_id UUID REFERENCES print_sessions(id),
    
    -- Event data
    event_data JSONB,
    
    -- Timestamp
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Indexing
    INDEX idx_analytics_kiosk_time (kiosk_id, occurred_at),
    INDEX idx_analytics_event_type (event_type, occurred_at)
);

-- Daily Aggregations Table (pre-computed for admin dashboard)
CREATE TABLE daily_stats (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    kiosk_id UUID REFERENCES kiosks(id),
    
    -- Transaction metrics
    total_sessions INTEGER DEFAULT 0,
    completed_sessions INTEGER DEFAULT 0,
    total_prints INTEGER DEFAULT 0,
    total_pages INTEGER DEFAULT 0,
    
    -- Revenue metrics
    total_revenue DECIMAL(10,2) DEFAULT 0,
    bw_pages INTEGER DEFAULT 0,
    color_pages INTEGER DEFAULT 0,
    
    -- Performance metrics
    avg_session_duration_seconds INTEGER,
    failed_prints INTEGER DEFAULT 0,
    
    -- Timestamps
    last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(date, kiosk_id)
);

-- Admin Users Table
CREATE TABLE admin_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(255),
    role VARCHAR(20) DEFAULT 'viewer', -- admin, manager, viewer
    
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Security
    is_active BOOLEAN DEFAULT true,
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP
);

-- Audit Logs Table
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_user_id UUID REFERENCES admin_users(id),
    action VARCHAR(100) NOT NULL, -- login, view_transactions, export_data
    resource_type VARCHAR(50),
    resource_id UUID,
    ip_address INET,
    user_agent TEXT,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Indexes for Performance

```sql
-- Print jobs - most queried table
CREATE INDEX idx_print_jobs_session ON print_jobs(session_id);
CREATE INDEX idx_print_jobs_kiosk_status ON print_jobs(kiosk_id, status);
CREATE INDEX idx_print_jobs_created ON print_jobs(created_at DESC);
CREATE INDEX idx_print_jobs_status ON print_jobs(status) WHERE status IN ('pending', 'queued', 'printing');

-- Payments
CREATE INDEX idx_payments_transaction ON payments(transaction_id);
CREATE INDEX idx_payments_status ON payments(status, created_at);

-- Sessions
CREATE INDEX idx_sessions_kiosk ON print_sessions(kiosk_id, created_at DESC);
CREATE INDEX idx_sessions_status ON print_sessions(status);

-- Analytics
CREATE INDEX idx_analytics_time_series ON analytics_events(occurred_at DESC);
CREATE INDEX idx_daily_stats_date ON daily_stats(date DESC);
```

---

## API Endpoints

### Kiosk/Public APIs

#### Session Management
```
POST   /api/v1/sessions
  → Create new print session
  Body: { kioskId: string }
  Response: { sessionId, expiresAt, kioskInfo }

GET    /api/v1/sessions/:sessionId
  → Get session status
  Response: { session, document, printJob, payment }

DELETE /api/v1/sessions/:sessionId
  → Cancel/expire session
```

#### Document Upload
```
POST   /api/v1/sessions/:sessionId/documents
  → Upload document
  Content-Type: multipart/form-data
  Body: { file: File }
  Response: { documentId, pages, size, preview }

GET    /api/v1/documents/:documentId/preview
  → Get document preview (thumbnail URLs)
  Response: { pages: [url], totalPages }
```

#### Print Job Management
```
POST   /api/v1/sessions/:sessionId/print-jobs
  → Create print job with settings
  Body: {
    documentId: UUID,
    settings: {
      colorMode: 'bw' | 'color',
      copies: number,
      paperSize: 'a4' | 'letter',
      orientation: 'portrait' | 'landscape',
      printSides: 'single' | 'double'
    }
  }
  Response: { jobId, pricing, estimatedTime }

GET    /api/v1/print-jobs/:jobId
  → Get print job status
  Response: { status, progress, errorMessage }

PATCH  /api/v1/print-jobs/:jobId/settings
  → Update print settings (before payment)
  Body: { settings: {...} }
```

#### Payment
```
POST   /api/v1/sessions/:sessionId/payments/initiate
  → Initiate payment
  Body: { 
    paymentMethod: 'upi' | 'card' | 'wallet',
    amount: number 
  }
  Response: { 
    transactionId, 
    paymentGatewayUrl, 
    qrCode (for UPI) 
  }

POST   /api/v1/payments/webhook
  → Payment gateway webhook
  Body: { gatewayData }

GET    /api/v1/payments/:transactionId/status
  → Check payment status (polling endpoint)
  Response: { status, transactionId }
```

#### Real-time Updates (WebSocket)
```
WS     /api/v1/sessions/:sessionId/updates
  → Subscribe to session updates
  Events:
    - document_processed
    - payment_success
    - print_queued
    - print_started
    - print_progress: { percentage, pagesCompleted }
    - print_completed
    - print_failed: { error }
```

### Admin Dashboard APIs

#### Authentication
```
POST   /api/v1/admin/login
  Body: { email, password }
  Response: { accessToken, refreshToken, user }

POST   /api/v1/admin/refresh
  Body: { refreshToken }
  Response: { accessToken }

POST   /api/v1/admin/logout
```

#### Dashboard Analytics
```
GET    /api/v1/admin/dashboard/overview
  Query: { period: 'today' | 'week' | 'month' | 'year' }
  Response: {
    totalRevenue: number,
    totalTransactions: number,
    totalPages: number,
    averageOrderValue: number,
    revenueGrowth: number,
    topKiosks: Array<{kioskId, revenue, transactions}>
  }

GET    /api/v1/admin/dashboard/revenue
  Query: { 
    startDate: ISO8601, 
    endDate: ISO8601, 
    groupBy: 'hour' | 'day' | 'week' | 'month',
    kioskId?: UUID 
  }
  Response: {
    timeSeries: Array<{date, revenue, transactions, pages}>,
    breakdown: { bw, color }
  }

GET    /api/v1/admin/dashboard/kiosks
  → Kiosk health and status
  Response: Array<{
    kioskId,
    status,
    lastHeartbeat,
    todayRevenue,
    todayTransactions,
    printerStatus
  }>
```

#### Transactions
```
GET    /api/v1/admin/transactions
  Query: {
    page: number,
    limit: number,
    startDate?: ISO8601,
    endDate?: ISO8601,
    kioskId?: UUID,
    status?: string,
    search?: string (sessionId, transactionId)
  }
  Response: {
    transactions: Array<Transaction>,
    pagination: { total, page, limit, pages }
  }

GET    /api/v1/admin/transactions/:id
  → Transaction detail view
  Response: { transaction, session, document, printJob, payment }

POST   /api/v1/admin/transactions/:id/refund
  Body: { reason: string }
```

#### Reports & Exports
```
GET    /api/v1/admin/reports/daily-summary
  Query: { date: ISO8601 }
  Response: { date, revenue, transactions, kiosks: [...] }

POST   /api/v1/admin/exports/transactions
  Body: { 
    startDate, 
    endDate, 
    format: 'csv' | 'xlsx' | 'pdf',
    filters: {...} 
  }
  Response: { exportId, status }

GET    /api/v1/admin/exports/:exportId
  → Download exported file
```

#### Kiosk Management
```
GET    /api/v1/admin/kiosks
POST   /api/v1/admin/kiosks
  Body: { kioskId, location, raspberryPiId, capabilities }

PATCH  /api/v1/admin/kiosks/:id
PUT    /api/v1/admin/kiosks/:id/status
  Body: { status: 'active' | 'maintenance' | 'offline' }

GET    /api/v1/admin/kiosks/:id/logs
  Query: { startDate, endDate, level }
```

---

## Raspberry Pi Integration Architecture

### Communication Pattern: **Job Queue with WebSocket Heartbeat**

#### Why This Approach?
- **Reliability**: Jobs persisted in database, no loss on network issues
- **Scalability**: Each Pi independently polls for jobs
- **Simplicity**: No need for complex MQTT broker setup
- **Monitoring**: Easy to track Pi health via heartbeat

### Pi Agent Architecture

```javascript
// Pseudo-code for Raspberry Pi Agent

class PrinterAgent {
  constructor(kioskId, backendUrl) {
    this.kioskId = kioskId;
    this.backendUrl = backendUrl;
    this.ws = null;
    this.printerStatus = 'idle';
  }

  async start() {
    // 1. Connect WebSocket for real-time updates
    this.connectWebSocket();
    
    // 2. Start heartbeat (every 30 seconds)
    setInterval(() => this.sendHeartbeat(), 30000);
    
    // 3. Poll for print jobs (every 5 seconds)
    setInterval(() => this.pollJobs(), 5000);
    
    // 4. Monitor printer status
    this.startPrinterMonitoring();
  }

  connectWebSocket() {
    this.ws = new WebSocket(`${this.backendUrl}/api/v1/kiosks/${this.kioskId}/connect`);
    
    this.ws.on('message', (data) => {
      const event = JSON.parse(data);
      
      if (event.type === 'new_job') {
        this.pollJobs(); // Immediate job check
      }
      
      if (event.type === 'cancel_job') {
        this.cancelJob(event.jobId);
      }
    });
  }

  async sendHeartbeat() {
    await fetch(`${this.backendUrl}/api/v1/kiosks/${this.kioskId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        status: this.printerStatus,
        printerInfo: await this.getPrinterInfo(),
        systemStats: {
          cpuUsage: getCpuUsage(),
          memoryUsage: getMemoryUsage(),
          diskSpace: getDiskSpace()
        }
      })
    });
  }

  async pollJobs() {
    if (this.printerStatus !== 'idle') return;

    const response = await fetch(
      `${this.backendUrl}/api/v1/kiosks/${this.kioskId}/jobs/next`
    );
    
    const { job } = await response.json();
    
    if (job) {
      await this.printJob(job);
    }
  }

  async printJob(job) {
    try {
      this.printerStatus = 'printing';
      
      // 1. Download document from S3
      await this.updateJobStatus(job.id, 'downloading');
      const filePath = await this.downloadDocument(job.documentUrl);
      
      // 2. Convert to printer-ready format if needed
      await this.updateJobStatus(job.id, 'processing');
      const printReady = await this.convertDocument(filePath, job.settings);
      
      // 3. Send to CUPS printer
      await this.updateJobStatus(job.id, 'printing');
      await this.sendToPrinter(printReady, job.settings);
      
      // 4. Monitor print progress
      await this.monitorPrintProgress(job.id);
      
      // 5. Mark complete
      await this.updateJobStatus(job.id, 'completed');
      
      // 6. Cleanup
      await this.cleanupFiles([filePath, printReady]);
      
    } catch (error) {
      await this.updateJobStatus(job.id, 'failed', error.message);
    } finally {
      this.printerStatus = 'idle';
    }
  }

  async sendToPrinter(filePath, settings) {
    // Use CUPS lp command
    const command = `lp -d ${PRINTER_NAME} \
      -o media=${settings.paperSize} \
      -o orientation-requested=${settings.orientation === 'portrait' ? 3 : 4} \
      -o sides=${settings.printSides === 'double' ? 'two-sided-long-edge' : 'one-sided'} \
      -n ${settings.copies} \
      ${settings.colorMode === 'bw' ? '-o ColorModel=Gray' : ''} \
      ${filePath}`;
    
    return execPromise(command);
  }

  async updateJobStatus(jobId, status, errorMessage = null) {
    await fetch(`${this.backendUrl}/api/v1/print-jobs/${jobId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ 
        status, 
        errorMessage,
        printedPages: await this.getPagesPrinted(),
        timestamp: new Date().toISOString()
      })
    });
    
    // Also send via WebSocket for real-time update
    this.ws.send(JSON.stringify({
      type: 'job_update',
      jobId,
      status
    }));
  }
}

// Start agent
const agent = new PrinterAgent(process.env.KIOSK_ID, process.env.BACKEND_URL);
agent.start();
```

### Backend Endpoints for Pi

```
POST   /api/v1/kiosks/:kioskId/heartbeat
  → Update kiosk status and health metrics

GET    /api/v1/kiosks/:kioskId/jobs/next
  → Get next pending print job for this kiosk
  Response: { job: {...} } or { job: null }

PATCH  /api/v1/print-jobs/:jobId/status
  → Update print job status from Pi
  Body: { status, errorMessage?, printedPages?, timestamp }

WS     /api/v1/kiosks/:kioskId/connect
  → WebSocket connection for real-time commands
  Server→Pi: { type: 'new_job' | 'cancel_job' | 'update_config' }
  Pi→Server: { type: 'job_update' | 'heartbeat' | 'error' }

GET    /api/v1/kiosks/:kioskId/config
  → Get kiosk configuration (print settings, pricing, etc.)
```

---

## Security Considerations

### Kiosk APIs
1. **Rate Limiting**: 
   - IP-based: 100 requests/minute per IP
   - Session-based: 50 requests/minute per session
2. **Session Expiry**: 15-minute timeout for inactive sessions
3. **File Upload Validation**:
   - Max file size: 10MB
   - Allowed types: PDF, PNG, JPEG
   - Virus scanning (ClamAV)
4. **CORS**: Whitelist kiosk frontend domains
5. **Payment Security**: 
   - Use payment gateway SDKs (Razorpay, Stripe)
   - Never store card details
   - PCI-DSS compliance for card payments

### Admin Dashboard
1. **Authentication**: 
   - JWT with refresh tokens
   - Access token: 15 min expiry
   - Refresh token: 7 day expiry
2. **Authorization**: Role-based access control (RBAC)
3. **Password Policy**:
   - Minimum 12 characters
   - Bcrypt hashing (cost factor 12)
4. **MFA**: Optional 2FA via TOTP
5. **Audit Logging**: Log all admin actions
6. **IP Whitelisting**: Optional for production

### Raspberry Pi
1. **API Key Authentication**: Each Pi has unique API key
2. **TLS/SSL**: All Pi↔Backend communication over HTTPS
3. **Network Isolation**: Pi on separate VLAN from public network
4. **Auto-updates**: Secure update mechanism for Pi agent
5. **Local File Encryption**: Encrypt downloaded documents

---

## Scalability & Performance

### Horizontal Scaling Strategy

#### Application Layer
- **Stateless API servers**: Scale API instances behind load balancer
- **Session storage in Redis**: Shared sessions across instances
- **Health checks**: `/health` endpoint for load balancer

#### Database Layer
- **Read Replicas**: Route read-heavy queries (analytics) to replicas
- **Connection Pooling**: pg-pool with 20 connections per instance
- **Partitioning**: Partition `analytics_events` by month
- **Archival**: Move old data (>1 year) to cold storage

#### File Storage
- **CDN**: CloudFront/CloudFlare in front of S3 for document previews
- **Lifecycle Policies**: Delete uploaded files after 30 days
- **Multi-region**: Replicate S3 buckets for disaster recovery

#### Job Queue
- **Multiple Workers**: Scale print workers per kiosk
- **Priority Queue**: Urgent jobs (failed retries) get priority
- **Dead Letter Queue**: Handle failed jobs separately

### Performance Optimizations

1. **Caching Strategy**:
   - Kiosk config: 5 min TTL
   - Daily stats: 1 hour TTL
   - Session data: Session lifetime
   
2. **Database Query Optimization**:
   - Use materialized views for complex analytics
   - Index frequently queried columns
   - EXPLAIN ANALYZE for slow queries

3. **Document Processing**:
   - Async processing (don't block upload response)
   - Generate thumbnails in background
   - Pre-render first page preview

4. **API Response Times**:
   - P95 target: <200ms for most endpoints
   - P95 target: <1s for document upload
   - WebSocket latency: <100ms

---

## Monitoring & Alerts

### Key Metrics to Monitor

#### Business Metrics
- Revenue per hour/day/week
- Average transaction value
- Conversion rate (sessions → completed prints)
- Failed print rate
- Average session duration

#### Technical Metrics
- API response time (P50, P95, P99)
- Error rate (5xx responses)
- Print job queue length
- Document processing time
- Database query performance

#### Infrastructure Metrics
- CPU/Memory usage
- Disk I/O
- Network throughput
- Redis memory usage
- Database connections

### Alert Thresholds

```yaml
alerts:
  - name: HighErrorRate
    condition: error_rate > 5%
    duration: 5m
    severity: critical
    
  - name: PrinterOffline
    condition: kiosk_heartbeat_missing > 2m
    severity: high
    
  - name: PaymentFailureSpike
    condition: payment_failure_rate > 10%
    duration: 5m
    severity: high
    
  - name: SlowAPI
    condition: api_p95_latency > 500ms
    duration: 10m
    severity: medium
    
  - name: QueueBacklog
    condition: print_queue_length > 50
    severity: medium
```

---

## Deployment Architecture

### Recommended Setup (Production)

```yaml
# docker-compose.yml (simplified)
version: '3.8'

services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - api
      
  api:
    build: ./backend
    deploy:
      replicas: 3
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/mprnt
      - REDIS_URL=redis://redis:6379
      - S3_BUCKET=mprnt-documents
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - postgres
      - redis
      
  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=mprnt
      - POSTGRES_USER=mprnt_user
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
      
  worker:
    build: ./backend
    command: npm run worker
    deploy:
      replicas: 2
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/mprnt
      - REDIS_URL=redis://redis:6379
      
  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      
  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"

volumes:
  postgres_data:
  redis_data:
```

### CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm ci
      - run: npm run test
      - run: npm run lint
      
  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build Docker image
        run: docker build -t mprnt-api:${{ github.sha }} .
      - name: Push to registry
        run: docker push mprnt-api:${{ github.sha }}
        
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to production
        run: |
          kubectl set image deployment/api \
            api=mprnt-api:${{ github.sha }}
          kubectl rollout status deployment/api
```

---

## Cost Estimation (Monthly)

### Small Scale (5 Kiosks, ~500 prints/day)

| Component | Service | Cost |
|-----------|---------|------|
| Compute | AWS EC2 t3.medium (2x) | $60 |
| Database | RDS PostgreSQL db.t3.small | $30 |
| Cache | ElastiCache t3.micro | $15 |
| Storage | S3 (100GB) + CDN | $10 |
| Monitoring | CloudWatch + Grafana Cloud | $20 |
| **Total** | | **~$135/month** |

### Medium Scale (50 Kiosks, ~5000 prints/day)

| Component | Service | Cost |
|-----------|---------|------|
| Compute | AWS ECS Fargate (6 tasks) | $180 |
| Database | RDS PostgreSQL db.m5.large | $150 |
| Cache | ElastiCache t3.small (cluster) | $45 |
| Storage | S3 (1TB) + CDN | $40 |
| Load Balancer | ALB | $25 |
| Monitoring | DataDog / New Relic | $100 |
| **Total** | | **~$540/month** |

### Self-Hosted (Minimum Viable)

| Component | Details | Cost |
|-----------|---------|------|
| VPS | 4 vCPU, 8GB RAM, 200GB SSD | $40 |
| Backup Storage | BackBlaze B2 (1TB) | $5 |
| Domain + SSL | Cloudflare | $0 |
| **Total** | | **~$45/month** |

---

## Development Roadmap

### Phase 1: MVP (4-6 weeks)
- [ ] Core API: Sessions, Documents, Print Jobs
- [ ] Payment integration (Razorpay)
- [ ] Basic admin dashboard (analytics, transactions)
- [ ] Single Pi integration with CUPS
- [ ] PostgreSQL + Redis setup
- [ ] Docker deployment

### Phase 2: Production Ready (2-4 weeks)
- [ ] WebSocket real-time updates
- [ ] Multi-kiosk support
- [ ] Advanced analytics (time-series, trends)
- [ ] Automated testing (unit + integration)
- [ ] Monitoring & alerting setup
- [ ] Security hardening

### Phase 3: Scale & Optimize (Ongoing)
- [ ] Load testing & optimization
- [ ] Read replicas for analytics
- [ ] CDN for document previews
- [ ] Mobile admin app
- [ ] Advanced reporting (PDF exports)
- [ ] A/B testing framework

---

## Tech Stack Alternatives

### Database Alternatives
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| PostgreSQL | ACID, mature, jsonb support | - | ✅ **Recommended** |
| MongoDB | Flexible schema, easy scaling | No transactions (pre-4.0) | ❌ Not needed |
| MySQL | Widely used, familiar | Weaker JSON support | ⚠️ Acceptable |

### Queue Alternatives
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Bull (Redis) | Simple, same infra as cache | Redis dependency | ✅ **Recommended** |
| RabbitMQ | Mature, feature-rich | Extra service | ⚠️ If scaling heavily |
| AWS SQS | Managed, scalable | Vendor lock-in | ⚠️ If on AWS |

### Payment Gateway (India)
| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Razorpay | Best UPI support, good docs | 2% fee | ✅ **Recommended** |
| Paytm | High brand trust | Complex integration | ⚠️ Alternative |
| Stripe | Global, excellent DX | Higher fees in India | ❌ Not ideal |

---

## Conclusion

This architecture provides:
- ✅ **Unified backend** serving both kiosk and admin
- ✅ **Scalable** from 1 to 1000s of kiosks
- ✅ **Reliable** print job queue with retries
- ✅ **Real-time** updates via WebSocket
- ✅ **Secure** payment and data handling
- ✅ **Observable** with comprehensive monitoring
- ✅ **Cost-effective** starting at $45/month

The system is designed for **iterative development**—start with MVP on a single VPS, then scale components as usage grows. The unified backend approach minimizes complexity while maximizing code reuse and maintainability.

---

## Next Steps

1. **Review & Approve**: Discuss architecture decisions with team
2. **Setup Development Environment**: Docker, PostgreSQL, Redis locally
3. **API Spec**: Finalize OpenAPI/Swagger specification
4. **Repository Structure**: Setup monorepo (backend + pi-agent + admin)
5. **Sprint Planning**: Break down Phase 1 into 2-week sprints

**Questions to Answer:**
- Payment gateway preference? (Razorpay vs. others)
- Cloud provider? (AWS, GCP, DigitalOcean, self-hosted)
- Admin dashboard framework? (React Admin, Retool, custom React)
- Pi management approach? (SSH access, auto-updates strategy)
