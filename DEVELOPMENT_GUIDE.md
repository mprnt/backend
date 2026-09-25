# MPrnt Backend - Development Guide

## 🎯 Purpose of This Document

This guide explains **how to work with Claude Code** to build the MPrnt backend incrementally, using the `BACKEND_ARCHITECTURE.md` as reference.

---

## ⚠️ Important: Don't Ask Claude to "Build Everything"

**Why?**
- Too many decisions need human input
- Quality control requires review of each component
- Integration points need testing
- Security requires careful validation

**Instead:** Build iteratively, one feature at a time, with testing and review.

---

## 📅 Development Phases

### Phase 0: Project Setup (1-2 days)

#### Session 1: Initialize Project
```
📝 Prompt for Claude:

"Let's set up the MPrnt backend project. Reference: backend-docs/BACKEND_ARCHITECTURE.md

Please:
1. Create a Node.js project with TypeScript
2. Set up Express.js with basic middleware
3. Configure ESLint, Prettier, and Husky
4. Create folder structure:
   - src/
     - routes/
     - controllers/
     - services/
     - models/
     - middleware/
     - utils/
     - types/
   - tests/
   - scripts/
5. Add basic dependencies: express, typescript, pg, redis, etc.
6. Create .env.example with required environment variables
7. Set up nodemon for development"
```

#### Session 2: Docker Setup
```
📝 Prompt for Claude:

"Create docker-compose.yml for local development with:
- PostgreSQL 16
- Redis 7
- MinIO (S3 alternative)
- Adminer (database UI)

Also create:
- Dockerfile for the API
- .dockerignore
- README with setup instructions"
```

#### Session 3: Database Schema
```
📝 Prompt for Claude:

"Using the schema in backend-docs/BACKEND_ARCHITECTURE.md, create:
1. Database migration files (using node-pg-migrate)
2. SQL files in migrations/ folder
3. TypeScript types matching the schema
4. Database connection setup with connection pooling"
```

**🔍 Review Checklist:**
- [ ] All tables created with correct columns
- [ ] Indexes applied as per architecture doc
- [ ] Foreign keys have proper constraints
- [ ] Timestamps default to CURRENT_TIMESTAMP

---

### Phase 1: Core Session Management (Week 1)

#### Feature 1.1: Create Session
```
📝 Prompt for Claude:

"Implement POST /api/v1/sessions endpoint:

Requirements from BACKEND_ARCHITECTURE.md:
- Accept kioskId in body
- Generate unique sessionId (format: S{timestamp})
- Set expiry to 15 minutes from now
- Return session details and kiosk info

Please create:
1. Route in src/routes/sessions.ts
2. Controller in src/controllers/sessionController.ts
3. Service in src/services/sessionService.ts
4. Validation middleware
5. Unit tests
6. Integration test

Use proper error handling and return appropriate HTTP status codes."
```

**🔍 Review Checklist:**
- [ ] SessionId is unique
- [ ] Expiry time calculated correctly
- [ ] KioskId validated (exists in database)
- [ ] Tests cover success and error cases
- [ ] Proper logging added

#### Feature 1.2: Get Session Status
```
📝 Prompt for Claude:

"Implement GET /api/v1/sessions/:sessionId endpoint:

Should return:
- Session details
- Associated document (if any)
- Print job status (if any)
- Payment status (if any)

Handle:
- Session not found (404)
- Expired session (410 Gone)

Add tests and proper TypeScript types."
```

#### Feature 1.3: Session Expiry Job
```
📝 Prompt for Claude:

"Create a background job that:
1. Runs every minute
2. Finds expired sessions (expires_at < now)
3. Updates status to 'expired'
4. Deletes uploaded documents from S3
5. Logs the cleanup

Use Bull queue for this. Add monitoring metrics."
```

**🧪 Testing Session:**
```
📝 Prompt for Claude:

"Let's test the session endpoints manually:
1. Start the server
2. Create a test session via curl/Postman
3. Verify it returns correct data
4. Test with invalid kioskId
5. Test session expiry
6. Check database records

Show me the curl commands and expected responses."
```

---

### Phase 2: Document Upload (Week 2)

#### Feature 2.1: Document Upload
```
📝 Prompt for Claude:

"Implement POST /api/v1/sessions/:sessionId/documents:

Requirements:
- Accept multipart/form-data file upload
- Validate: file type (PDF/PNG/JPEG), size (<10MB)
- Upload to S3/MinIO
- Extract page count (use pdf-parse for PDFs)
- Store metadata in documents table
- Return document details

Use multer for file handling.
Add virus scanning later.

Include comprehensive error handling and tests."
```

#### Feature 2.2: Document Processing
```
📝 Prompt for Claude:

"Create background job for document processing:
1. Convert uploaded file to print-ready format
2. Generate thumbnail for preview
3. Store processed file in S3
4. Update document.processed = true

For MVP, we can use sharp for images and ghostscript for PDFs.
Add this as a Bull queue job."
```

#### Feature 2.3: Preview Endpoint
```
📝 Prompt for Claude:

"Implement GET /api/v1/documents/:documentId/preview:

Return:
- Array of thumbnail URLs (first 3 pages)
- Total page count
- Document status

Generate pre-signed S3 URLs with 1-hour expiry."
```

**🧪 Testing Session:**
```
📝 Prompt for Claude:

"Create test script to:
1. Create session
2. Upload sample PDF
3. Wait for processing
4. Fetch preview
5. Verify all data correct

Provide sample test files."
```

---

### Phase 3: Print Jobs & Pricing (Week 3)

#### Feature 3.1: Create Print Job
```
📝 Prompt for Claude:

"Implement POST /api/v1/sessions/:sessionId/print-jobs:

Requirements from BACKEND_ARCHITECTURE.md:
- Accept print settings (color, copies, paper size, etc.)
- Validate settings
- Calculate pricing based on rules:
  - B&W: ₹2/page
  - Color: ₹10/page
  - Double-sided counts as half pages (rounded up)
  - Multiply by copies
- Create print_job record
- Return jobId and pricing breakdown

Add comprehensive validation and tests."
```

#### Feature 3.2: Pricing Calculator Service
```
📝 Prompt for Claude:

"Create a dedicated pricing service:

class PricingService {
  calculatePrice(settings, documentPages): Pricing
}

With clear logic for:
- Base price per page
- Double-sided adjustment
- Copy multiplication
- Future: volume discounts, promotions

Make it easy to add pricing rules.
Add unit tests for all scenarios."
```

#### Feature 3.3: Update Print Settings
```
📝 Prompt for Claude:

"Implement PATCH /api/v1/print-jobs/:jobId/settings:

Allow updating settings before payment.
Recalculate pricing.
Only allow if payment.status = 'pending'.

Return updated pricing."
```

---

### Phase 4: Payment Integration (Week 4)

#### Feature 4.1: Payment Gateway Setup
```
📝 Prompt for Claude:

"Set up Razorpay integration:
1. Install razorpay npm package
2. Create PaymentService with:
   - initiate(): create Razorpay order
   - verify(): verify payment signature
   - refund(): process refund
3. Store API keys in environment
4. Add proper error handling

Use Razorpay test mode for now."
```

#### Feature 4.2: Initiate Payment
```
📝 Prompt for Claude:

"Implement POST /api/v1/sessions/:sessionId/payments/initiate:

1. Verify print job exists and is unpaid
2. Create Razorpay order
3. Store payment record (status: pending)
4. Return:
   - transactionId
   - razorpayOrderId
   - amount
   - For UPI: generate QR code

Handle payment method: upi, card, wallet"
```

#### Feature 4.3: Payment Webhook
```
📝 Prompt for Claude:

"Implement POST /api/v1/payments/webhook:

1. Verify Razorpay signature
2. Update payment status
3. If success:
   - Update print_job status to 'queued'
   - Queue print job in Bull
   - Emit WebSocket event to frontend
4. Handle failures
5. Log all webhook events

Add webhook verification tests."
```

#### Feature 4.4: Payment Status Polling
```
📝 Prompt for Claude:

"Implement GET /api/v1/payments/:transactionId/status:

Allow frontend to poll payment status.
Rate limit: 1 request per second.
Return current payment status.

Also implement long-polling version with 30s timeout."
```

**🧪 Testing Payment Flow:**
```
📝 Prompt for Claude:

"Create test script using Razorpay test cards:
1. Create session + document + print job
2. Initiate payment
3. Simulate webhook (success/failure)
4. Verify status updates
5. Check database records

Provide test card numbers and webhook payloads."
```

---

### Phase 5: Print Job Queue (Week 5)

#### Feature 5.1: Bull Queue Setup
```
📝 Prompt for Claude:

"Set up Bull queue for print jobs:

1. Create printQueue in src/queues/printQueue.ts
2. Configure:
   - Redis connection
   - Job retention (completed: 24h, failed: 7 days)
   - Retry strategy (3 attempts, exponential backoff)
   - Priority queue support
3. Add queue monitoring dashboard (Bull Board)
4. Create job processor skeleton

Add health check endpoint for queue."
```

#### Feature 5.2: Queue Job Processor
```
📝 Prompt for Claude:

"Implement print job processor:

Process function should:
1. Fetch job details from database
2. Download document from S3
3. Update status to 'printing'
4. (For now) Simulate printing with delay
5. Update status to 'completed'
6. Emit WebSocket event
7. Handle errors and retries

Add comprehensive logging.
Test with actual queue jobs."
```

#### Feature 5.3: Job Status Endpoint
```
📝 Prompt for Claude:

"Implement GET /api/v1/print-jobs/:jobId:

Return:
- Print job details
- Current status
- Progress (if printing)
- Error message (if failed)
- Estimated completion time

Cache this in Redis with 5s TTL for performance."
```

---

### Phase 6: WebSocket Real-time Updates (Week 6)

#### Feature 6.1: WebSocket Server Setup
```
📝 Prompt for Claude:

"Set up Socket.IO for real-time updates:

1. Install socket.io
2. Integrate with Express server
3. Add authentication (verify sessionId)
4. Create event handlers:
   - connection
   - disconnect
   - subscribe to session updates
5. Add Redis adapter for multi-instance support

Create src/websocket/socketServer.ts"
```

#### Feature 6.2: Session Update Events
```
📝 Prompt for Claude:

"Implement WebSocket events for:
- document_processed
- payment_success
- print_queued
- print_started
- print_progress (with percentage)
- print_completed
- print_failed

Create EventEmitter service that other parts of the app can use.
Test event delivery."
```

---

### Phase 7: Raspberry Pi Integration (Week 7-8)

#### Feature 7.1: Pi Heartbeat Endpoint
```
📝 Prompt for Claude:

"Implement POST /api/v1/kiosks/:kioskId/heartbeat:

Accept from Pi agent:
- status: idle, printing, error
- printerInfo: CUPS printer details
- systemStats: CPU, memory, disk

Update kiosk record with:
- last_heartbeat timestamp
- printer_status
- Update status to 'offline' if no heartbeat >5 min

Add authentication using API key."
```

#### Feature 7.2: Job Polling Endpoint
```
📝 Prompt for Claude:

"Implement GET /api/v1/kiosks/:kioskId/jobs/next:

1. Fetch next queued job for this kiosk
2. Mark as 'printing'
3. Return job details with:
   - documentUrl (pre-signed S3)
   - print settings
   - jobId
4. If no jobs, return { job: null }

Add idempotency: same job not given twice.
Rate limit: 1 request per 5 seconds per kiosk."
```

#### Feature 7.3: Job Status Update from Pi
```
📝 Prompt for Claude:

"Implement PATCH /api/v1/print-jobs/:jobId/status:

Accept from Pi:
- status: downloading, processing, printing, completed, failed
- errorMessage (if failed)
- printedPages (progress)
- timestamp

Update database.
Emit WebSocket event to session.
Handle job retries if failed.

Validate only Pi agent can update (API key auth)."
```

#### Feature 7.4: Pi WebSocket Connection
```
📝 Prompt for Claude:

"Create WebSocket endpoint for Pi agents:

WS /api/v1/kiosks/:kioskId/connect

Server can send:
- new_job: trigger immediate polling
- cancel_job: stop current print
- update_config: apply new settings

Pi can send:
- job_update: status changes
- heartbeat: keep-alive
- error: report issues

Add reconnection logic on Pi side."
```

---

### Phase 8: Admin Dashboard Backend (Week 9-10)

#### Feature 8.1: Admin Authentication
```
📝 Prompt for Claude:

"Implement admin authentication:

POST /api/v1/admin/login:
- Accept email + password
- Verify with bcrypt
- Generate JWT (access: 15min, refresh: 7d)
- Return tokens + user info

POST /api/v1/admin/refresh:
- Verify refresh token
- Issue new access token

Add middleware to verify JWT on admin routes.
Implement role-based access control."
```

#### Feature 8.2: Dashboard Overview
```
📝 Prompt for Claude:

"Implement GET /api/v1/admin/dashboard/overview:

Calculate and return:
- Total revenue (today, week, month)
- Transaction count
- Total pages printed
- Average order value
- Revenue growth % (compared to previous period)
- Top 5 kiosks by revenue

Use daily_stats table for performance.
Cache results for 5 minutes."
```

#### Feature 8.3: Revenue Analytics
```
📝 Prompt for Claude:

"Implement GET /api/v1/admin/dashboard/revenue:

Query params:
- startDate, endDate
- groupBy: hour/day/week/month
- kioskId (optional)

Return time series data:
- Array of { date, revenue, transactions, pages }
- Breakdown: { bw, color }

Optimize query with indexes.
Support date range up to 1 year."
```

#### Feature 8.4: Transaction List
```
📝 Prompt for Claude:

"Implement GET /api/v1/admin/transactions:

Features:
- Pagination (page, limit)
- Filters: date range, kiosk, status
- Search: sessionId, transactionId
- Sort: date, amount

Return:
- Transactions array with all details
- Pagination metadata

Add CSV export functionality."
```

---

## 🧪 Testing Strategy

### For Each Feature:

1. **Unit Tests**
   ```
   📝 "Write unit tests for [service/function name]:
   - Happy path
   - Edge cases
   - Error scenarios
   - Use Jest with proper mocking"
   ```

2. **Integration Tests**
   ```
   📝 "Write integration test for [endpoint]:
   - Use supertest
   - Test with real database (test DB)
   - Clean up after tests
   - Test authentication/authorization"
   ```

3. **Manual Testing**
   ```
   📝 "Create Postman collection for [feature]:
   - Include all endpoints
   - With example requests/responses
   - Add environment variables"
   ```

---

## 🔒 Security Review Points

After each major phase, ask Claude:

```
📝 "Review the [feature] implementation for security issues:
- Input validation
- SQL injection risks
- Authentication bypass
- Rate limiting
- Error message leakage
- Logging sensitive data
- CORS configuration

Suggest improvements."
```

---

## 📊 Progress Tracking

Create a checklist file:

```bash
# Ask Claude to create:
"Create PROGRESS.md with checkboxes for all features listed in this guide."
```

---

## 🚀 Deployment Preparation (Week 11)

```
📝 Final sessions with Claude:

1. "Create production-ready Dockerfile with:
   - Multi-stage build
   - Security best practices
   - Health check"

2. "Set up CI/CD pipeline (GitHub Actions):
   - Run tests
   - Build Docker image
   - Deploy to staging"

3. "Create deployment documentation:
   - Environment variables
   - Database migration steps
   - Monitoring setup
   - Backup strategy"

4. "Set up monitoring:
   - Prometheus metrics
   - Grafana dashboards
   - Alert rules from BACKEND_ARCHITECTURE.md"
```

---

## 💡 Tips for Working with Claude

### ✅ Do:
- Break features into small, testable chunks
- Review generated code before moving on
- Ask for explanations when unclear
- Request tests for every feature
- Iterate on code quality

### ❌ Don't:
- Ask to "build the entire backend"
- Skip testing
- Move forward with buggy code
- Ignore security concerns
- Accept code you don't understand

### 🎯 Good Prompts:
- "Implement X endpoint according to the spec in BACKEND_ARCHITECTURE.md"
- "Add error handling for Y scenario"
- "Write tests for Z function covering these cases: ..."
- "Refactor this code to improve readability"
- "Review this implementation for security issues"

### ❌ Bad Prompts:
- "Build the whole payment system"
- "Make it work"
- "Add everything from the architecture doc"

---

## 📝 Session Notes Template

Keep notes in `backend-docs/session-notes/`:

```markdown
# Session YYYY-MM-DD: [Feature Name]

## What We Built
- Endpoint: POST /api/v1/...
- Files created: ...
- Tests added: ...

## Decisions Made
- Choice: Use Bull instead of SQS
- Reason: Simpler for MVP, same infra as Redis

## Issues Found
- Bug in payment validation
- Fixed by adding null check

## Next Session
- Implement webhook handler
- Add webhook signature verification
```

---

## 🎓 Learning Approach

This is not just about building—it's about learning:

1. **Understand each piece** before moving to next
2. **Ask Claude "why"** for design decisions
3. **Review tests** to understand edge cases
4. **Run the code** locally and verify it works
5. **Refactor** when you see patterns

---

## ⏱️ Realistic Timeline

- **MVP (Phases 0-5)**: 6-8 weeks (part-time)
- **Production Ready (Phases 6-8)**: +4-6 weeks
- **Total**: 10-14 weeks for complete backend

**With Claude's help**: ~60% faster than coding alone, but still needs your judgment and review.

---

## 🤝 When to Seek Human Help

Ask experienced developers (not Claude) for:
- Architecture decisions (scaling strategy)
- Production deployment advice
- Security audits
- Performance optimization strategies
- Payment gateway compliance (PCI-DSS)

---

## 📚 Resources to Learn Alongside

While building with Claude:
- Node.js best practices (goldbergyoni/nodebestpractices)
- Express.js security (helmet, cors)
- PostgreSQL performance tuning
- Payment gateway documentation (Razorpay)
- WebSocket scaling patterns

---

**Remember**: The goal is not just to finish the backend, but to **understand** what you've built so you can maintain and scale it.
