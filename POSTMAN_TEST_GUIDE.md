# MPrnt Backend - Postman Testing Guide

This document contains all the API endpoints you can test with Postman as we build the backend.

**Last Updated**: 2026-09-23

---

## 🔧 Setup

### Environment Variables

Create a Postman environment with these variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `base_url` | `http://localhost:3000` | API base URL |
| `api_version` | `v1` | API version |
| `session_id` | (auto-set) | Created session ID |
| `kiosk_id` | `M001` | Test kiosk ID |

---

## ✅ Phase 1: Core Session Management

### 0. List All Sessions (NEW)

**Endpoint**: `GET {{base_url}}/api/{{api_version}}/sessions`

**Description**: Lists all sessions with filtering, pagination, and stats

**Headers**: None required

**Query Parameters** (all optional):
```
status: draft | complete | expired
kioskId: M001
limit: 20 (default, max 100)
offset: 0 (default)
```

**Example Requests**:

1. **Get all sessions**:
   ```
   GET http://localhost:3000/api/v1/sessions
   ```

2. **Get only active (draft) sessions**:
   ```
   GET http://localhost:3000/api/v1/sessions?status=draft
   ```

3. **Get sessions for specific kiosk**:
   ```
   GET http://localhost:3000/api/v1/sessions?kioskId=M001
   ```

4. **Get with pagination**:
   ```
   GET http://localhost:3000/api/v1/sessions?limit=10&offset=0
   ```

**Expected Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "sessions": [
      {
        "sessionId": "S1790173800121",
        "status": "draft",
        "isExpired": false,
        "createdAt": "2026-09-23T14:30:00.121Z",
        "expiresAt": "2026-09-23T14:45:00.121Z",
        "completedAt": null,
        "kiosk": {
          "kioskId": "M001",
          "location": "Main Building - Floor 1",
          "status": "active",
          "printerStatus": "idle"
        }
      }
    ],
    "pagination": {
      "total": 35,
      "limit": 20,
      "offset": 0
    },
    "stats": {
      "active": 5,
      "expired": 30
    }
  }
}
```

**Use Cases**:
- ✅ See how many sessions are currently running
- ✅ Find expired sessions that need cleanup
- ✅ Monitor sessions for a specific kiosk
- ✅ Admin dashboard overview

---

### 1. Create Session

**Endpoint**: `POST {{base_url}}/api/{{api_version}}/sessions`

**Description**: Creates a new print session for a kiosk

**Headers**:
```
Content-Type: application/json
```

**Request Body**:
```json
{
  "kioskId": "{{kiosk_id}}"
}
```

**Expected Response** (201 Created):
```json
{
  "status": "success",
  "data": {
    "sessionId": "S1727099164205",
    "expiresAt": "2026-09-23T14:21:04.205Z",
    "createdAt": "2026-09-23T14:06:04.205Z",
    "status": "draft",
    "kioskInfo": {
      "kioskId": "M001",
      "location": "Main Building - Floor 1",
      "capabilities": {
        "color": true,
        "duplex": true,
        "paper_sizes": ["a4", "letter"]
      },
      "status": "active"
    }
  }
}
```

**Post-Response Script** (Save session_id):
```javascript
if (pm.response.code === 201) {
    const response = pm.response.json();
    pm.environment.set("session_id", response.data.sessionId);
    console.log("Session ID saved:", response.data.sessionId);
}
```

**Test Cases**:
- ✅ Success: Valid kiosk ID
- ❌ Error 404: Invalid kiosk ID
- ❌ Error 400: Inactive kiosk (status: maintenance)
- ❌ Error 400: Missing kioskId in body
- ❌ Error 429: Rate limit exceeded (>10 requests/minute)

---

### 2. Get Session Details

**Endpoint**: `GET {{base_url}}/api/{{api_version}}/sessions/{{session_id}}`

**Description**: Retrieves complete session details including document, print job, and payment info

**Headers**: None required

**Expected Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "session": {
      "sessionId": "S1727099164205",
      "status": "draft",
      "createdAt": "2026-09-23T14:06:04.205Z",
      "expiresAt": "2026-09-23T14:21:04.205Z",
      "completedAt": null
    },
    "kiosk": {
      "kioskId": "M001",
      "location": "Main Building - Floor 1",
      "status": "active",
      "capabilities": {
        "color": true,
        "duplex": true,
        "paper_sizes": ["a4", "letter"]
      }
    },
    "document": null,
    "printJob": null,
    "payment": null
  }
}
```

**Test Cases**:
- ✅ Success: Valid session ID (no document uploaded yet)
- ✅ Success: Session with document
- ✅ Success: Session with document + print job
- ✅ Success: Session with document + print job + payment
- ❌ Error 404: Invalid session ID
- ❌ Error 410: Expired session (wait 15+ minutes after creation)

---

### 3. Cancel Session

**Endpoint**: `DELETE {{base_url}}/api/{{api_version}}/sessions/{{session_id}}`

**Description**: Manually cancel/expire a session

**Headers**: None required

**Expected Response** (200 OK):
```json
{
  "status": "success",
  "message": "Session cancelled successfully",
  "data": {
    "sessionId": "S1727099164205",
    "status": "expired",
    "completedAt": "2026-09-23T14:10:30.123Z"
  }
}
```

**Test Cases**:
- ✅ Success: Cancel active session
- ❌ Error 404: Invalid session ID
- ❌ Error 400: Cannot cancel completed session

---

## 🧪 Testing Scenarios

### Scenario 1: Happy Path - Simple Session

```
1. POST /api/v1/sessions (with valid kioskId)
   → Save session_id from response
   
2. GET /api/v1/sessions/{{session_id}}
   → Verify session exists with status "draft"
   → Verify document, printJob, payment are all null
   
3. DELETE /api/v1/sessions/{{session_id}}
   → Verify session is cancelled
   → Status changes to "expired"
```

### Scenario 2: Session Expiry

```
1. POST /api/v1/sessions (with valid kioskId)
   → Save session_id
   
2. Wait 16 minutes (or modify expires_at in database for faster testing)
   
3. GET /api/v1/sessions/{{session_id}}
   → Should return 410 Gone
   → Message: "Session has expired"
```

### Scenario 3: Invalid Kiosk Testing

```
1. POST /api/v1/sessions
   Body: { "kioskId": "INVALID" }
   → Should return 404
   → Message: "Kiosk not found"
   
2. POST /api/v1/sessions
   Body: { "kioskId": "M002" }  (assuming M002 is in maintenance)
   → Should return 400
   → Message: "Kiosk is currently maintenance. Please try another kiosk."
```

### Scenario 4: Rate Limiting

**Updated 2026-09-23: Rate limiting now properly configured to 10 requests/minute**

```
1. Send 15 POST requests to /api/v1/sessions rapidly (within 1 minute)
   → First 10 should succeed (201)
   → 11th onward should return 429 (Too Many Requests)
   → Response: "Too many session creation requests. Please try again later."
   
2. Check response headers on each request:
   RateLimit-Limit: 10
   RateLimit-Remaining: (decreases with each request)
   RateLimit-Reset: (timestamp when limit resets)
   
3. Wait 1 minute after getting rate limited
   → Try again (should work - 201)
```

**How to test in Postman:**
1. Open the POST /api/v1/sessions request
2. Click "Send" button 15 times quickly
3. Watch the status codes change from 201 to 429

Or use Postman Runner:
1. Collections → Right-click → Run collection
2. Set iterations to 15
3. Set delay to 0ms
4. Run
5. View results - should see 10 success, 5 failures

---

### Scenario 5: Session Expiry

If you want to test the session expiry job manually:

### Check Expired Sessions

```sql
-- Find all sessions that should be expired
SELECT 
  session_id,
  status,
  created_at,
  expires_at,
  CASE 
    WHEN expires_at < CURRENT_TIMESTAMP THEN 'EXPIRED'
    ELSE 'ACTIVE'
  END as should_be_status
FROM print_sessions
WHERE status != 'expired'
  AND expires_at < CURRENT_TIMESTAMP;
```

### Manually Trigger Expiry (for testing)

You can manually set a session to expire soon:

```sql
-- Make a session expire in 1 minute
UPDATE print_sessions
SET expires_at = CURRENT_TIMESTAMP + INTERVAL '1 minute'
WHERE session_id = 'S1727099164205';
```

Then wait 2 minutes and the background job will automatically expire it.

---

## 🚀 Advanced Testing Tips

### Using Postman Collections

1. **Create a Collection**: Organize all endpoints into a collection
2. **Use Pre-request Scripts**: Set up data before each request
3. **Use Tests Tab**: Add assertions to automatically verify responses

Example Test Script for "Create Session":
```javascript
pm.test("Status code is 201", function () {
    pm.response.to.have.status(201);
});

pm.test("Response has session ID", function () {
    const response = pm.response.json();
    pm.expect(response.data).to.have.property('sessionId');
    pm.expect(response.data.sessionId).to.match(/^S\d+$/);
});

pm.test("Session expires in ~15 minutes", function () {
    const response = pm.response.json();
    const expiresAt = new Date(response.data.expiresAt);
    const createdAt = new Date(response.data.createdAt);
    const diffMinutes = (expiresAt - createdAt) / (1000 * 60);
    pm.expect(diffMinutes).to.be.within(14.9, 15.1);
});
```

### Using Newman (Postman CLI)

Run tests from command line:
```bash
newman run mprnt-backend.postman_collection.json \
  -e environment.postman_environment.json \
  --reporters cli,json
```

---

## 🔍 Monitoring Background Jobs

The session expiry job runs every minute. To monitor it:

1. **Check Logs**: Look at your server console
   - You'll see: `"Starting session expiry job"`
   - Success: `"Session expiry job completed"`
   - Errors: `"Session expiry job failed"`

2. **Check Redis Queue**: Use a Redis client
   ```bash
   redis-cli
   > KEYS bull:session-expiry:*
   ```

3. **Database Query**: Check which sessions got expired
   ```sql
   SELECT session_id, status, expires_at, completed_at
   FROM print_sessions
   WHERE status = 'expired'
   ORDER BY completed_at DESC
   LIMIT 10;
   ```

---

## 📊 Current Test Coverage

| Endpoint | Method | Tests | Status |
|----------|--------|-------|--------|
| `/api/v1/sessions` | POST | 5 | ✅ Ready |
| `/api/v1/sessions/:sessionId` | GET | 6 | ✅ Ready |
| `/api/v1/sessions/:sessionId` | DELETE | 3 | ✅ Ready |

**Total**: 14 test cases ready for Phase 1

---

## 🎯 Next Phase (Coming Soon)

### Phase 2: Document Upload

- `POST /api/v1/sessions/:sessionId/documents` - Upload document
- `GET /api/v1/documents/:documentId/preview` - Get preview thumbnails

*This section will be populated as we implement Phase 2*

---

## 🐛 Common Issues & Solutions

### Issue 1: "Cannot connect to localhost:3000"
**Solution**: Make sure the server is running
```bash
npm run dev
```

### Issue 2: "Kiosk not found" for M001
**Solution**: Insert test kiosk into database
```sql
INSERT INTO kiosks (kiosk_id, location, status, capabilities)
VALUES (
  'M001',
  'Main Building - Floor 1',
  'active',
  '{"color": true, "duplex": true, "paper_sizes": ["a4", "letter"]}'
);
```

### Issue 3: Session expires too quickly
**Solution**: For testing, you can modify the expiry time in the code temporarily
```typescript
// In sessionService.ts - calculateExpiry()
// Change: expiry.setMinutes(expiry.getMinutes() + 15);
// To: expiry.setMinutes(expiry.getMinutes() + 60); // 1 hour for testing
```

---

## 📚 Resources

- [Postman Documentation](https://learning.postman.com/docs/)
- [Writing Postman Tests](https://learning.postman.com/docs/writing-scripts/test-scripts/)
- [Newman CLI](https://learning.postman.com/docs/running-collections/using-newman-cli/)

---

**Need Help?**
- Check the main API documentation: `BACKEND_ARCHITECTURE.md`
- Review the development guide: `DEVELOPMENT_GUIDE.md`
- Check server logs for detailed error messages

---

## 📄 Phase 2: Document Upload (NEW)

### 4. Upload Document

**Endpoint**: `POST {{base_url}}/api/{{api_version}}/sessions/{{session_id}}/documents`

**Description**: Upload a document (PDF, PNG, or JPEG) for a session

**Headers**:
```
Content-Type: multipart/form-data
```

**Body** (form-data):
- **Key**: `document` (type: File)
- **Value**: Select a PDF, PNG, or JPEG file (max 10MB)

**Expected Response** (201 Created):
```json
{
  "status": "success",
  "message": "Document uploaded successfully",
  "data": {
    "documentId": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "sample.pdf",
    "fileType": "application/pdf",
    "fileSizeBytes": 245760,
    "pageCount": null,
    "processed": false,
    "uploadedAt": "2026-09-23T15:45:07.399Z"
  }
}
```

**How to Upload in Postman**:
1. Go to "Body" tab
2. Select "form-data" (NOT "raw")
3. Add key: `document`
4. Change type from "Text" to "File"
5. Click "Select Files" and choose PDF/PNG/JPEG

**Test Cases**:
- ✅ Success: Upload valid PDF (<10MB)
- ✅ Success: Upload valid PNG (<10MB)
- ✅ Success: Upload valid JPEG (<10MB)
- ❌ Error 400: Invalid file type (.docx, .txt)
- ❌ Error 400: File > 10MB
- ❌ Error 400: No file provided
- ❌ Error 400: Document already uploaded
- ❌ Error 404: Invalid session ID
- ❌ Error 410: Session expired

---

### 5. Get Session Document

**Endpoint**: `GET {{base_url}}/api/{{api_version}}/sessions/{{session_id}}/documents`

**Description**: Get uploaded document for a session

**Expected Response** (200 OK):
```json
{
  "status": "success",
  "data": {
    "documentId": "550e8400-e29b-41d4-a716-446655440000",
    "filename": "sample.pdf",
    "fileType": "application/pdf",
    "fileSizeBytes": 245760,
    "pageCount": null,
    "processed": false,
    "uploadedAt": "2026-09-23T15:45:07.399Z"
  }
}
```

---

## 🧪 New Testing Scenarios

### Scenario 6: Complete Document Upload Flow

```
1. POST /api/v1/sessions
   Body: { "kioskId": "M001" }
   → Save session_id

2. POST /api/v1/sessions/{{session_id}}/documents
   Form-data: document = sample.pdf
   → 201 Created with document details

3. GET /api/v1/sessions/{{session_id}}/documents
   → Returns uploaded document

4. GET /api/v1/sessions/{{session_id}}
   → Shows document in session details
```

### Scenario 7: Duplicate Upload Protection

```
1. Create session
2. Upload document → ✅ 201
3. Try uploading another document
   → ❌ 400 "Document already uploaded for this session"
```

---

## 🎯 Phase 2 Progress

**Phase 2.1: Document Upload** ✅ **COMPLETE**
- POST /api/v1/sessions/:sessionId/documents ✅
- GET /api/v1/sessions/:sessionId/documents ✅
- File validation (type, size) ✅
- S3/MinIO integration ✅
- Duplicate prevention ✅

**Phase 2.2: Document Processing** ❌ (Not started)
**Phase 2.3: Preview Endpoint** ❌ (Not started)

---

## 📊 Updated Test Coverage

| Phase | Endpoint | Method | Tests | Status |
|-------|----------|--------|-------|--------|
| 1 | `/api/v1/sessions` | POST | 5 | ✅ |
| 1 | `/api/v1/sessions` | GET | 5 | ✅ |
| 1 | `/api/v1/sessions/:id` | GET | 6 | ✅ |
| 1 | `/api/v1/sessions/:id` | DELETE | 3 | ✅ |
| 2.1 | `/api/v1/sessions/:id/documents` | POST | 9 | ✅ NEW |
| 2.1 | `/api/v1/sessions/:id/documents` | GET | 2 | ✅ NEW |

**Total**: 30 test cases (Phase 1 + Phase 2.1)

