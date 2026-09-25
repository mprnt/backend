# MPrnt Backend API - Swagger Documentation Setup

## Quick Setup

### 1. Install Swagger Packages
```bash
npm install --save swagger-jsdoc swagger-ui-express
npm install --save-dev @types/swagger-jsdoc @types/swagger-ui-express
```

### 2. Update app.ts
Add this import at the top:
```typescript
import { setupSwagger } from './config/swagger';
```

Add this line BEFORE your routes (around line 60):
```typescript
// Swagger documentation
setupSwagger(app);
```

### 3. Access Swagger UI
- **Swagger UI**: http://localhost:3000/api-docs
- **OpenAPI JSON**: http://localhost:3000/api-docs.json

---

## API Overview

### Base URL
```
http://localhost:3000/api/v1
```

---

## 📋 Complete API Endpoints

### **1. Sessions** 🎫

#### Create Session
```http
POST /api/v1/sessions
Content-Type: application/json

{
  "kioskId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Get Session
```http
GET /api/v1/sessions/{sessionId}
```

#### List Sessions
```http
GET /api/v1/sessions?status=active&limit=20&offset=0
```

#### Cancel Session
```http
DELETE /api/v1/sessions/{sessionId}
```

---

### **2. Documents** 📄

#### Upload Document
```http
POST /api/v1/sessions/{sessionId}/documents
Content-Type: multipart/form-data

file: [PDF file]
```

#### Get Session Document
```http
GET /api/v1/sessions/{sessionId}/documents
```

#### Get Document Details
```http
GET /api/v1/documents/{documentId}
```

#### Get Document Preview
```http
GET /api/v1/documents/{documentId}/preview
```

#### Get Download URL
```http
GET /api/v1/documents/{documentId}/download
```

#### Delete Document
```http
DELETE /api/v1/documents/{documentId}
```

---

### **3. Print Jobs** 🖨️

#### Create Print Job
```http
POST /api/v1/sessions/{sessionId}/print-jobs
Content-Type: application/json

{
  "colorMode": "bw",
  "copies": 1,
  "pageRange": "all",
  "printSides": "single",
  "paperSize": "a4",
  "orientation": "portrait"
}
```

**Pricing:**
- Black & White: ₹2.00/page
- Color: ₹5.00/page
- Double-sided: Physical pages = ceil(logical pages / 2)

#### Get Print Job
```http
GET /api/v1/print-jobs/{jobId}
```

#### List Session Print Jobs
```http
GET /api/v1/sessions/{sessionId}/print-jobs
```

#### Update Print Settings
```http
PATCH /api/v1/print-jobs/{jobId}/settings
Content-Type: application/json

{
  "colorMode": "color",
  "copies": 2
}
```

---

### **4. Payment** 💳

#### Create Payment Order
```http
POST /api/v1/print-jobs/{jobId}/payment/order
```

#### Simulate Payment Success (Mock)
```http
POST /api/v1/payment/mock/simulate-success
Content-Type: application/json

{
  "orderId": "order_mock_1727235636304_abc123"
}
```

#### Verify Payment
```http
POST /api/v1/payment/verify
Content-Type: application/json

{
  "orderId": "order_mock_1727235636304_abc123",
  "paymentId": "pay_mock_1727235636304_xyz789",
  "signature": "generated_signature_here"
}
```

#### Get Payment Order
```http
GET /api/v1/payment/order/{orderId}
```

#### Get Job Payment
```http
GET /api/v1/print-jobs/{jobId}/payment
```

#### Simulate Payment Failure (Mock)
```http
POST /api/v1/payment/mock/simulate-failure
Content-Type: application/json

{
  "orderId": "order_mock_1727235636304_abc123",
  "errorCode": "PAYMENT_DECLINED"
}
```

---

### **5. Health Check** ❤️

#### Health Check
```http
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2026-09-25T07:02:00.565Z",
  "uptime": 3600,
  "environment": "development"
}
```

---

## 📊 Data Models

### Session
```typescript
{
  sessionId: "S1727235636304",
  kioskId: "550e8400-e29b-41d4-a716-446655440000",
  status: "active" | "complete" | "expired" | "error",
  expiresAt: "2026-09-25T08:02:00.565Z",
  createdAt: "2026-09-25T07:02:00.565Z"
}
```

### Document
```typescript
{
  documentId: "uuid",
  fileName: "document.pdf",
  fileSize: 1024000,
  mimeType: "application/pdf",
  pageCount: 10,
  processed: true,
  uploadedAt: "2026-09-25T07:02:00.565Z"
}
```

### Print Job
```typescript
{
  jobId: "uuid",
  sessionId: "S1727235636304",
  settings: {
    colorMode: "bw" | "color",
    copies: 1-100,
    pageRange: "all" | "custom",
    customRange?: "1-5,8,10-12",
    printSides: "single" | "double",
    paperSize: "a4" | "letter",
    orientation: "portrait" | "landscape"
  },
  pricing: {
    pricePerPage: 2.0,
    logicalPages: 10,
    physicalPages: 5,
    totalPages: 10,
    totalAmount: 20.0
  },
  status: "pending" | "queued" | "printing" | "completed" | "failed",
  createdAt: "2026-09-25T07:02:00.565Z"
}
```

### Payment Order
```typescript
{
  orderId: "order_mock_1727235636304_abc123",
  amount: 20.0,
  currency: "INR",
  status: "created" | "pending" | "captured" | "failed",
  createdAt: "2026-09-25T07:02:00.565Z"
}
```

---

## 🔄 Complete Workflow Example

### Step 1: Create Session
```bash
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"kioskId": "550e8400-e29b-41d4-a716-446655440000"}'
```
Save: `sessionId`

### Step 2: Upload Document
```bash
curl -X POST http://localhost:3000/api/v1/sessions/S1727235636304/documents \
  -F "file=@document.pdf"
```
Save: `documentId`

### Step 3: Create Print Job
```bash
curl -X POST http://localhost:3000/api/v1/sessions/S1727235636304/print-jobs \
  -H "Content-Type: application/json" \
  -d '{
    "colorMode": "bw",
    "copies": 2,
    "pageRange": "all",
    "printSides": "double"
  }'
```
Save: `jobId`, `totalAmount`

### Step 4: Create Payment Order
```bash
curl -X POST http://localhost:3000/api/v1/print-jobs/{jobId}/payment/order
```
Save: `orderId`

### Step 5: Simulate Payment
```bash
curl -X POST http://localhost:3000/api/v1/payment/mock/simulate-success \
  -H "Content-Type: application/json" \
  -d '{"orderId": "order_mock_1727235636304_abc123"}'
```
Save: `paymentId`, `signature`

### Step 6: Verify Payment
```bash
curl -X POST http://localhost:3000/api/v1/payment/verify \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "order_mock_1727235636304_abc123",
    "paymentId": "pay_mock_1727235636304_xyz789",
    "signature": "generated_signature"
  }'
```
Job status → `queued` ✅

---

## 🚨 Error Responses

### 400 Bad Request
```json
{
  "status": "error",
  "message": "Validation failed",
  "errors": [
    {
      "field": "colorMode",
      "message": "Color mode must be either 'bw' or 'color'"
    }
  ]
}
```

### 404 Not Found
```json
{
  "status": "error",
  "message": "Session not found"
}
```

### 429 Too Many Requests
```json
{
  "status": "error",
  "message": "Too many requests, please try again later"
}
```

---

## 📝 Adding New Endpoints (Future Development)

When adding new endpoints, follow this pattern:

### 1. Add JSDoc Comment to Route
```typescript
/**
 * @swagger
 * /your-new-endpoint:
 *   post:
 *     summary: Brief description
 *     description: Detailed description
 *     tags: [YourTag]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               field:
 *                 type: string
 *     responses:
 *       200:
 *         description: Success response
 */
router.post('/your-new-endpoint', handler);
```

### 2. Add Schema to swagger.ts (if needed)
```typescript
components: {
  schemas: {
    YourNewModel: {
      type: 'object',
      properties: {
        // your fields
      }
    }
  }
}
```

### 3. Add Tag to swagger.ts
```typescript
tags: [
  {
    name: 'YourTag',
    description: 'Description of your tag'
  }
]
```

---

## 🎯 Testing with Swagger UI

1. **Start server**: `npm run dev`
2. **Open**: http://localhost:3000/api-docs
3. **Click "Try it out"** on any endpoint
4. **Fill parameters**
5. **Click "Execute"**
6. **View response**

---

## 📦 Export Options

### Export as Postman Collection
1. Go to http://localhost:3000/api-docs.json
2. Copy the JSON
3. In Postman: Import → Raw text → Paste → Import

### Export as OpenAPI YAML
```bash
curl http://localhost:3000/api-docs.json | \
  npx js-yaml > openapi.yaml
```

---

## ✅ Checklist for Each Phase

When implementing new features:

- [ ] Create types in `src/types/`
- [ ] Create service in `src/services/`
- [ ] Create controller in `src/controllers/`
- [ ] Create validator in `src/validators/`
- [ ] Create routes in `src/routes/`
- [ ] **Add Swagger JSDoc comments to routes**
- [ ] **Add schemas to swagger.ts (if new models)**
- [ ] **Add tags to swagger.ts (if new category)**
- [ ] Mount routes in `src/app.ts`
- [ ] Test endpoints via Swagger UI
- [ ] Update this README with new endpoints

---

## 🔒 Rate Limits

- **Global**: 100 requests / 15 minutes per IP
- **Session Creation**: 10 requests / 15 minutes per IP

---

## 📞 Support

For issues or questions:
- GitHub Issues: [your-repo]/issues
- Email: support@mprnt.com
- Swagger UI: http://localhost:3000/api-docs

---

**Last Updated**: 2026-09-25  
**API Version**: 1.0.0  
**Phases Complete**: 1-4 (Sessions, Documents, Print Jobs, Payment)
