# MPrnt Backend Implementation Guide

**Last Updated:** 2026-09-25  
**Status:** Core implementation complete, frontend integration pending

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Current Implementation Status](#current-implementation-status)
4. [API Endpoints](#api-endpoints)
5. [Database Schema](#database-schema)
6. [Frontend Integration Issues](#frontend-integration-issues)
7. [Setup Instructions](#setup-instructions)
8. [Testing the API](#testing-the-api)
9. [Next Steps](#next-steps)

---

## Overview

MPrnt Backend is a RESTful API service for managing print kiosk operations. It handles:

- **Session Management**: User print sessions at kiosks
- **Document Upload & Processing**: PDF/image document handling
- **Print Job Management**: Print settings, pricing calculations, and job queuing
- **Payment Processing**: Mock payment gateway integration (ready for Razorpay)
- **Print Queue**: Job queue management for printer coordination

### Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with node-postgres
- **Documentation**: Swagger/OpenAPI 3.0
- **File Upload**: Multer
- **Validation**: Joi
- **Environment**: dotenv

---

## Architecture

```
mprnt-backend/
├── src/
│   ├── config/              # Configuration files
│   │   ├── database.ts      # PostgreSQL connection pool
│   │   ├── environment.ts   # Environment variables
│   │   └── swagger.ts       # API documentation setup
│   │
│   ├── controllers/         # Request handlers
│   │   ├── sessionController.ts
│   │   ├── documentController.ts
│   │   ├── printJobController.ts
│   │   ├── paymentController.ts
│   │   └── queueController.ts
│   │
│   ├── services/            # Business logic
│   │   ├── sessionService.ts
│   │   ├── documentService.ts
│   │   ├── printJobService.ts
│   │   ├── paymentService.ts
│   │   └── queueService.ts
│   │
│   ├── repositories/        # Database operations
│   │   ├── sessionRepository.ts
│   │   ├── documentRepository.ts
│   │   ├── printJobRepository.ts
│   │   ├── paymentRepository.ts
│   │   └── queueRepository.ts
│   │
│   ├── routes/              # API route definitions
│   │   ├── sessions.ts
│   │   ├── documents.ts
│   │   ├── printJobs.ts
│   │   ├── payment.ts
│   │   └── queue.ts
│   │
│   ├── validators/          # Request validation schemas
│   │   ├── sessionValidator.ts
│   │   ├── printJobValidator.ts
│   │   └── paymentValidator.ts
│   │
│   ├── middleware/          # Express middleware
│   │   ├── errorHandler.ts
│   │   ├── rateLimiter.ts
│   │   ├── upload.ts
│   │   └── validate.ts
│   │
│   ├── types/               # TypeScript type definitions
│   │   ├── session.ts
│   │   ├── document.ts
│   │   ├── printJob.ts
│   │   ├── payment.ts
│   │   └── queue.ts
│   │
│   ├── utils/               # Utility functions
│   │   ├── logger.ts
│   │   └── asyncHandler.ts
│   │
│   ├── app.ts               # Express app setup
│   └── server.ts            # Server entry point
│
├── migrations/              # Database migrations
│   ├── 001_create_sessions_table.sql
│   ├── 002_create_documents_table.sql
│   ├── 003_create_print_jobs_table.sql
│   ├── 004_create_print_settings_table.sql
│   ├── 005_create_pricing_table.sql
│   ├── 006_create_payment_orders_table.sql
│   ├── 007_add_payment_metadata.sql
│   └── 008_add_print_queue.sql
│
└── uploads/                 # Uploaded files (gitignored)
```

---

## Current Implementation Status

### ✅ Completed Features

#### 1. Session Management
- [x] Create new print session
- [x] Get session details
- [x] List sessions with filtering
- [x] Cancel/expire sessions
- [x] Automatic session timeout (30 minutes)

#### 2. Document Handling
- [x] Upload documents (PDF, PNG, JPEG)
- [x] File validation (type, size limits)
- [x] Document metadata storage
- [x] Session-document association
- [x] Document preview with thumbnails
- [x] Pre-signed download URLs
- [x] Document deletion

#### 3. Print Job Management
- [x] Create print job with settings
- [x] Dynamic pricing calculation
  - B&W: ₹2/page
  - Color: ₹10/page
  - Double-sided: Half the sheets
- [x] Page range validation (all, custom ranges)
- [x] Update job settings (before payment)
- [x] Job status tracking

#### 4. Payment System
- [x] Create payment orders
- [x] Mock payment gateway simulation
- [x] Payment verification
- [x] Payment failure handling
- [x] Order status tracking

#### 5. Print Queue (Raspberry Pi Integration)
- [x] Printer registration system
- [x] Printer heartbeat monitoring
- [x] Job polling by printer capabilities
- [x] Job status updates from printers
- [x] Queue statistics and monitoring
- [x] Printer list management
- [x] Pre-signed URLs for document download

#### 6. Infrastructure
- [x] PostgreSQL database with 8 migrations
- [x] Comprehensive error handling
- [x] Request validation with Joi
- [x] Rate limiting
- [x] Swagger API documentation
- [x] CORS configuration
- [x] Logging with Winston
- [x] Health check endpoint

### 🚧 Pending for Frontend Integration

- [ ] Response format alignment (CRITICAL)
- [ ] Optional kioskId in session creation
- [ ] Print job field name mapping
- [ ] Payment polling endpoint
- [ ] Document preview thumbnail generation (placeholder implementation)

---

## API Endpoints

Base URL: `http://localhost:3000/api/v1`

### Quick Reference

| Category | Endpoint | Method | Description |
|----------|----------|--------|-------------|
| **Sessions** | `/sessions` | POST | Create new session |
| | `/sessions` | GET | List sessions |
| | `/sessions/:id` | GET | Get session details |
| | `/sessions/:id` | DELETE | Cancel session |
| **Documents** | `/sessions/:sessionId/documents` | POST | Upload document |
| | `/sessions/:sessionId/documents` | GET | Get session document |
| | `/documents/:documentId` | GET | Get document details |
| | `/documents/:documentId/preview` | GET | Get preview thumbnails |
| | `/documents/:documentId/download` | GET | Get download URL |
| | `/documents/:documentId` | DELETE | Delete document |
| **Print Jobs** | `/sessions/:sessionId/print-jobs` | POST | Create print job |
| | `/sessions/:sessionId/print-jobs` | GET | List session jobs |
| | `/print-jobs/:jobId` | GET | Get job details |
| | `/print-jobs/:jobId/settings` | PATCH | Update job settings |
| **Payment** | `/print-jobs/:jobId/payment/order` | POST | Create payment order |
| | `/print-jobs/:jobId/payment` | GET | Get job payment |
| | `/payment/verify` | POST | Verify payment |
| | `/payment/order/:orderId` | GET | Get order details |
| | `/payment/failure` | POST | Handle failure |
| | `/payment/mock/simulate-success` | POST | Simulate success (mock) |
| | `/payment/mock/simulate-failure` | POST | Simulate failure (mock) |
| **Queue** | `/queue/printers/register` | POST | Register printer (RPi) |
| | `/queue/heartbeat` | POST | Update printer heartbeat |
| | `/queue/poll` | POST | Poll for next job |
| | `/queue/jobs/:jobId/status` | POST | Update job status |
| | `/queue/status` | GET | Get queue statistics |
| | `/queue/printers` | GET | List all printers |

---

### Sessions

```http
POST   /sessions
GET    /sessions
GET    /sessions/:sessionId
DELETE /sessions/:sessionId
```

**Create Session Example:**
```json
POST /api/v1/sessions
Content-Type: application/json

{
  "kioskId": "550e8400-e29b-41d4-a716-446655440000"
}

Response:
{
  "status": "success",
  "message": "Session created successfully",
  "data": {
    "sessionId": "S1727265168798",
    "kioskId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "active",
    "createdAt": "2026-09-25T11:12:48.798Z",
    "expiresAt": "2026-09-25T11:42:48.798Z"
  }
}
```

### Documents

```http
POST   /sessions/:sessionId/documents
GET    /sessions/:sessionId/documents
GET    /documents/:documentId
GET    /documents/:documentId/preview
GET    /documents/:documentId/download
DELETE /documents/:documentId
```

**Upload Document Example:**
```http
POST /api/v1/sessions/S1727265168798/documents
Content-Type: multipart/form-data

file: [PDF/PNG/JPEG file, max 10MB]

Response:
{
  "status": "success",
  "message": "Document uploaded successfully",
  "data": {
    "documentId": "d1a2b3c4-5678-90ab-cdef-1234567890ab",
    "sessionId": "S1727265168798",
    "filename": "document.pdf",
    "originalName": "my-document.pdf",
    "mimeType": "application/pdf",
    "size": 1048576,
    "pageCount": 10,
    "uploadedAt": "2026-09-25T11:15:00.000Z"
  }
}
```

**Get Document Preview Example:**
```http
GET /api/v1/documents/d1a2b3c4-5678-90ab-cdef-1234567890ab/preview

Response:
{
  "status": "success",
  "data": {
    "documentId": "d1a2b3c4-5678-90ab-cdef-1234567890ab",
    "fileName": "my-document.pdf",
    "pageCount": 10,
    "thumbnails": [
      {
        "page": 1,
        "url": "https://s3.amazonaws.com/bucket/thumbnails/page1.jpg"
      },
      {
        "page": 2,
        "url": "https://s3.amazonaws.com/bucket/thumbnails/page2.jpg"
      }
      // ... more pages
    ]
  }
}
```

**Get Document Download URL Example:**
```http
GET /api/v1/documents/d1a2b3c4-5678-90ab-cdef-1234567890ab/download

Response:
{
  "status": "success",
  "data": {
    "documentId": "d1a2b3c4-5678-90ab-cdef-1234567890ab",
    "fileName": "my-document.pdf",
    "downloadUrl": "https://s3.amazonaws.com/bucket/documents/doc.pdf?signed=xyz",
    "expiresIn": 3600
  }
}
```

### Print Jobs

```http
POST  /sessions/:sessionId/print-jobs
GET   /sessions/:sessionId/print-jobs
GET   /print-jobs/:jobId
PATCH /print-jobs/:jobId/settings
```

**Create Print Job Example:**
```json
POST /api/v1/sessions/S1727265168798/print-jobs
Content-Type: application/json

{
  "colorMode": "bw",
  "copies": 1,
  "pageRange": "all",
  "printSides": "single",
  "paperSize": "a4",
  "orientation": "portrait"
}

Response:
{
  "status": "success",
  "message": "Print job created successfully",
  "data": {
    "jobId": "job-uuid-here",
    "sessionId": "S1727265168798",
    "documentId": "document-uuid",
    "kioskId": "kiosk-uuid",
    "settings": {
      "colorMode": "bw",
      "copies": 1,
      "pageRange": "all",
      "printSides": "single",
      "paperSize": "a4",
      "orientation": "portrait"
    },
    "pricing": {
      "pricePerPage": 2,
      "totalPages": 10,
      "totalAmount": 20
    },
    "status": "pending",
    "createdAt": "2026-09-25T11:16:00.000Z"
  }
}
```

### Payment

```http
POST /print-jobs/:jobId/payment/order
GET  /print-jobs/:jobId/payment
POST /payment/verify
GET  /payment/order/:orderId
POST /payment/failure

# Mock Testing Endpoints
POST /payment/mock/simulate-success
POST /payment/mock/simulate-failure
```

**Create Payment Order Example:**
```json
POST /api/v1/print-jobs/job-uuid/payment/order

Response:
{
  "status": "success",
  "message": "Payment order created successfully",
  "data": {
    "orderId": "order_mock_1727265168798_abc123",
    "jobId": "job-uuid",
    "amount": 20,
    "currency": "INR",
    "status": "pending",
    "provider": "mock",
    "createdAt": "2026-09-25T11:17:00.000Z",
    "checkoutUrl": "https://mock-payment-gateway.com/checkout/order_mock_...",
    "qrCode": "upi://pay?pa=merchant@upi&pn=MPrnt&am=20&cu=INR&tn=order_mock_..."
  }
}
```

**Verify Payment Example:**
```json
POST /api/v1/payment/verify
Content-Type: application/json

{
  "orderId": "order_mock_1727265168798_abc123",
  "paymentId": "pay_mock_1727265168798_xyz789",
  "signature": "generated_signature_hash"
}

Response:
{
  "status": "success",
  "message": "Payment verified and captured successfully",
  "data": {
    "verified": true,
    "paymentId": "pay_mock_1727265168798_xyz789",
    "orderId": "order_mock_1727265168798_abc123",
    "amount": 20,
    "currency": "INR",
    "method": "upi",
    "status": "captured",
    "capturedAt": "2026-09-25T11:18:00.000Z"
  }
}
```

### Print Queue

```http
POST   /queue/printers/register
POST   /queue/heartbeat
POST   /queue/poll
POST   /queue/jobs/:jobId/status
GET    /queue/status
GET    /queue/printers
```

---

## Database Schema

### Tables

#### 1. `sessions`
```sql
- session_id (VARCHAR PRIMARY KEY) - Format: S{timestamp}
- kiosk_id (UUID NOT NULL)
- status (VARCHAR) - 'active', 'complete', 'expired', 'error'
- created_at (TIMESTAMP)
- expires_at (TIMESTAMP)
- completed_at (TIMESTAMP)
```

#### 2. `documents`
```sql
- document_id (UUID PRIMARY KEY)
- session_id (VARCHAR FK → sessions)
- filename (VARCHAR) - Stored filename
- original_name (VARCHAR) - User's filename
- mime_type (VARCHAR)
- size (BIGINT) - File size in bytes
- page_count (INTEGER)
- uploaded_at (TIMESTAMP)
```

#### 3. `print_jobs`
```sql
- job_id (UUID PRIMARY KEY)
- session_id (VARCHAR FK → sessions)
- document_id (UUID FK → documents)
- kiosk_id (UUID NOT NULL)
- status (VARCHAR) - 'pending', 'queued', 'printing', 'completed', 'failed', 'cancelled'
- created_at (TIMESTAMP)
- updated_at (TIMESTAMP)
```

#### 4. `print_settings`
```sql
- setting_id (UUID PRIMARY KEY)
- job_id (UUID FK → print_jobs)
- color_mode (VARCHAR) - 'bw', 'color'
- copies (INTEGER DEFAULT 1)
- page_range (VARCHAR) - 'all', 'custom'
- custom_range (VARCHAR) - e.g., "1-5,8,10-12"
- print_sides (VARCHAR) - 'single', 'double'
- paper_size (VARCHAR) - 'a4', 'letter'
- orientation (VARCHAR) - 'portrait', 'landscape'
```

#### 5. `pricing`
```sql
- pricing_id (UUID PRIMARY KEY)
- job_id (UUID FK → print_jobs)
- price_per_page (DECIMAL(10,2))
- total_pages (INTEGER)
- total_amount (DECIMAL(10,2))
- calculated_at (TIMESTAMP)
```

#### 6. `payment_orders`
```sql
- order_id (VARCHAR PRIMARY KEY)
- job_id (UUID FK → print_jobs)
- amount (DECIMAL(10,2))
- currency (VARCHAR DEFAULT 'INR')
- status (VARCHAR) - 'pending', 'authorized', 'captured', 'failed', 'refunded'
- provider (VARCHAR DEFAULT 'mock')
- provider_order_id (VARCHAR)
- created_at (TIMESTAMP)
- updated_at (TIMESTAMP)
```

#### 7. `payment_metadata`
```sql
- metadata_id (UUID PRIMARY KEY)
- order_id (VARCHAR FK → payment_orders)
- payment_id (VARCHAR)
- payment_method (VARCHAR)
- signature (VARCHAR)
- error_code (VARCHAR)
- error_description (TEXT)
- captured_at (TIMESTAMP)
```

#### 8. `print_queue`
```sql
- queue_id (UUID PRIMARY KEY)
- job_id (UUID FK → print_jobs)
- kiosk_id (UUID NOT NULL)
- priority (INTEGER DEFAULT 0)
- status (VARCHAR) - 'queued', 'printing', 'completed', 'failed'
- queued_at (TIMESTAMP)
- started_printing_at (TIMESTAMP)
- completed_at (TIMESTAMP)
- error_message (TEXT)
```

---

## Frontend Integration Issues

### Issue 1: Response Format Mismatch 🔴 **CRITICAL**

**Problem:**  
Frontend expects direct response properties, but backend wraps everything in `{ status, message?, data }`.

**Frontend Expects:**
```typescript
// Document upload
{ document: Document }

// Print job creation
{ printJob: PrintJob }

// Payment order
{ order: PaymentOrder, checkoutUrl?: string, qrCode?: string }

// Payment verification
{ order: PaymentOrder, verified: boolean }
```

**Backend Currently Returns:**
```typescript
{
  status: 'success',
  message: 'Operation successful',
  data: { /* actual data here */ }
}
```

**Solution Required:**
Update all controllers to match frontend expectations. Either:
1. Change backend to return unwrapped responses, OR
2. Update frontend API client to unwrap responses

**Recommendation:** Change backend to match frontend (simpler).

---

### Issue 2: Session Creation - kioskId Required 🟡 **MEDIUM**

**Problem:**  
Backend requires `kioskId` in session creation, but frontend expects it to be optional.

**Frontend Code:**
```typescript
// Creates session without kioskId
async createSession(): Promise<Session> {
  const response = await this.request<CreateSessionResponse>('/sessions', {
    method: 'POST',
  });
  return response.session;
}
```

**Backend Validator:**
```typescript
// Currently requires kioskId
createSessionSchema: Joi.object({
  kioskId: Joi.string().uuid().required()
})
```

**Solution Required:**
1. Make `kioskId` optional in validator
2. Generate default kioskId if not provided (e.g., 'M001' or random UUID)

---

### Issue 3: Print Job Field Name Mismatch 🟡 **MEDIUM**

**Problem:**  
Frontend and backend use different field names for print options.

**Frontend Sends:**
```typescript
{
  documentId: string,
  options: {
    copies: number,
    colorMode: 'blackAndWhite' | 'color',  // ← Different
    paperSize: 'A4' | 'Letter',            // ← Different
    orientation: 'portrait' | 'landscape',
    duplex: 'none' | 'longEdge',           // ← Different
    quality: 'normal'
  }
}
```

**Backend Expects:**
```typescript
{
  colorMode: 'bw' | 'color',        // ← Different
  copies: number,
  pageRange: 'all' | 'custom',
  customRange?: string,
  printSides: 'single' | 'double',  // ← Different
  paperSize: 'a4' | 'letter',       // ← Different (case)
  orientation: 'portrait' | 'landscape'
}
```

**Solution Required:**
Add field mapping in controller:
```typescript
const backendFormat = {
  colorMode: options.colorMode === 'blackAndWhite' ? 'bw' : 'color',
  paperSize: options.paperSize.toLowerCase(),
  printSides: options.duplex === 'none' ? 'single' : 'double',
  // ... etc
};
```

---

### Issue 4: Payment Polling Endpoint Missing 🟡 **MEDIUM**

**Problem:**  
Frontend needs to poll payment status by `orderId` for UPI payments, but no simple GET endpoint exists.

**Frontend Code:**
```typescript
// Polls every 3 seconds
const pollInterval = setInterval(async () => {
  try {
    const result = await apiClient.verifyPayment({ orderId });
    
    if (result.verified && result.order.status === 'captured') {
      // Payment successful
      clearInterval(pollInterval);
      router.push('/processing');
    }
  } catch (error) {
    // Continue polling
  }
}, 3000);
```

**Current Issue:**  
The `/payment/verify` endpoint expects `paymentId` and `signature`, which the frontend doesn't have during UPI QR polling.

**Solution Required:**
Add endpoint:
```http
GET /payment/order/:orderId

Response:
{
  order: PaymentOrder,
  verified: boolean,
  printJob?: PrintJob
}
```

This allows checking status without payment credentials.

---

## Setup Instructions

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### 1. Clone and Install

```bash
cd mprnt-backend
npm install
```

### 2. Environment Configuration

Create `.env` file:

```env
# Server
NODE_ENV=development
PORT=3000
API_VERSION=v1

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mprnt_db
DB_USER=your_username
DB_PASSWORD=your_password

# File Upload
UPLOAD_DIR=uploads
MAX_FILE_SIZE=10485760  # 10MB in bytes

# CORS
CORS_ORIGIN=http://localhost:3001
CORS_CREDENTIALS=true

# Session
SESSION_TIMEOUT_MINUTES=30

# Payment (Mock)
PAYMENT_PROVIDER=mock
RAZORPAY_KEY_ID=your_key_id_here
RAZORPAY_KEY_SECRET=your_secret_here

# Logging
LOG_LEVEL=info
```

### 3. Database Setup

```bash
# Create database
createdb mprnt_db

# Run migrations in order
psql -d mprnt_db -f migrations/001_create_sessions_table.sql
psql -d mprnt_db -f migrations/002_create_documents_table.sql
psql -d mprnt_db -f migrations/003_create_print_jobs_table.sql
psql -d mprnt_db -f migrations/004_create_print_settings_table.sql
psql -d mprnt_db -f migrations/005_create_pricing_table.sql
psql -d mprnt_db -f migrations/006_create_payment_orders_table.sql
psql -d mprnt_db -f migrations/007_add_payment_metadata.sql
psql -d mprnt_db -f migrations/008_add_print_queue.sql
```

Or run all at once:
```bash
for file in migrations/*.sql; do
  psql -d mprnt_db -f "$file"
done
```

### 4. Create Upload Directory

```bash
mkdir uploads
```

### 5. Start Development Server

```bash
npm run dev
```

Server runs at: `http://localhost:3000`

API Documentation: `http://localhost:3000/api-docs`

---

## Testing the API

### Using Swagger UI

1. Open `http://localhost:3000/api-docs`
2. Explore endpoints with interactive documentation
3. Try out requests directly from the browser

### Complete Workflow Test

#### 1. Create Session
```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"kioskId":"550e8400-e29b-41d4-a716-446655440000"}'
```

Save the `sessionId` from response.

#### 2. Upload Document
```bash
curl -X POST http://localhost:3000/api/v1/sessions/S1727265168798/documents \
  -F "file=@/path/to/document.pdf"
```

Save the `documentId` from response.

#### 3. Create Print Job
```bash
curl -X POST http://localhost:3000/api/v1/sessions/S1727265168798/print-jobs \
  -H "Content-Type: application/json" \
  -d '{
    "colorMode": "bw",
    "copies": 1,
    "pageRange": "all",
    "printSides": "single",
    "paperSize": "a4",
    "orientation": "portrait"
  }'
```

Save the `jobId` from response.

#### 4. Create Payment Order
```bash
curl -X POST http://localhost:3000/api/v1/print-jobs/{jobId}/payment/order
```

Save the `orderId` from response.

#### 5. Simulate Payment Success
```bash
curl -X POST http://localhost:3000/api/v1/payment/mock/simulate-success \
  -H "Content-Type: application/json" \
  -d '{"orderId":"order_mock_1727265168798_abc123"}'
```

Get `paymentId` and `signature` from response.

#### 6. Verify Payment
```bash
curl -X POST http://localhost:3000/api/v1/payment/verify \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "order_mock_1727265168798_abc123",
    "paymentId": "pay_mock_1727265168798_xyz789",
    "signature": "generated_signature_hash"
  }'
```

#### 7. Check Queue Status
```bash
curl http://localhost:3000/api/v1/queue/jobs
```

---

## Next Steps

### Immediate (For Frontend Integration)

1. **Fix Response Format** 🔴 **HIGH PRIORITY**
   - Update all controllers to return unwrapped responses
   - Match frontend expectations exactly
   - Files to modify:
     - `src/controllers/sessionController.ts`
     - `src/controllers/documentController.ts`
     - `src/controllers/printJobController.ts`
     - `src/controllers/paymentController.ts`

2. **Make kioskId Optional** 🟡 **MEDIUM**
   - Update `src/validators/sessionValidator.ts`
   - Update `src/controllers/sessionController.ts` to generate default kioskId

3. **Add Print Job Field Mapping** 🟡 **MEDIUM**
   - Add mapping logic in `src/controllers/printJobController.ts`
   - Handle both frontend and direct API formats

4. **Add Payment Polling Endpoint** 🟡 **MEDIUM**
   - Add `GET /payment/order/:orderId` endpoint
   - Return current status without requiring payment credentials

### Short-term

5. **Document Preview Generation**
   - Implement PDF thumbnail generation
   - Return preview URLs in document response

6. **Real-time Updates**
   - Add WebSocket support for job status updates
   - Push queue status changes to frontend

7. **File Cleanup**
   - Implement automated cleanup of old uploads
   - Delete files when sessions expire

### Medium-term

8. **Razorpay Integration**
   - Replace mock payment with real Razorpay
   - Add webhook handlers
   - Implement payment reconciliation

9. **Admin Dashboard Backend**
   - Kiosk management endpoints
   - Analytics and reporting
   - User management

10. **Printer Integration**
    - Add printer driver communication
    - Implement job status callbacks
    - Handle printer errors

---

## Additional Resources

- **API Documentation**: `http://localhost:3000/api-docs` (when running)
- **Health Check**: `http://localhost:3000/health`
- **Database Migrations**: `migrations/` directory
- **Environment Template**: `.env.example` (create this based on setup)

---

## Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL is running
pg_isready

# Test connection
psql -h localhost -U your_username -d mprnt_db
```

### Upload Directory Permissions

```bash
# Ensure uploads directory is writable
chmod 755 uploads
```

### Port Already in Use

```bash
# Find process using port 3000
lsof -i :3000

# Kill process if needed
kill -9 <PID>

# Or change port in .env
PORT=3001
```

### CORS Issues

Ensure `CORS_ORIGIN` in `.env` matches your frontend URL exactly.

---

## Contact & Support

For questions or issues:
1. Check Swagger documentation at `/api-docs`
2. Review this guide
3. Check database logs
4. Review application logs

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-25  
**Backend Version:** v1  
**Database Version:** Migration 008
