# MPrnt Deployment Guide

## Quick Deploy to Railway

### Step 1: Frontend (Vercel)
```bash
cd mprnt-qr
git push origin main
# Go to vercel.com → Import mprnt-qr repo
# Set env var: NEXT_PUBLIC_API_URL=https://your-railway-backend.up.railway.app/api/v1
```

### Step 2: Backend (Railway)

**Via Railway CLI (Fastest):**
```bash
npm i -g @railway/cli
cd mprnt-backend
railway login
railway init
railway add --plugin postgres
railway variables add NODE_ENV=production
railway variables add API_VERSION=v1
railway up
```

**Or via Railway Dashboard:**
1. https://railway.app
2. New Project → GitHub (mprnt-backend)
3. Add PostgreSQL plugin
4. Set environment variables (see .env.production)
5. Deploy

### Step 3: Get Backend URL
After deploy, Railway gives you: `https://your-project.up.railway.app`

### Step 4: Update Frontend
In Vercel → Settings → Environment Variables:
```
NEXT_PUBLIC_API_URL=https://your-project.up.railway.app/api/v1
```
Redeploy Vercel.

### Step 5: QR Codes
Generate QR codes pointing to:
```
https://your-frontend.vercel.app/?kioskId=KIOSK001
https://your-frontend.vercel.app/?kioskId=KIOSK002
```

---

## Production Checklist

- [ ] Frontend deployed to Vercel
- [ ] Backend deployed to Railway
- [ ] PostgreSQL database created
- [ ] Environment variables set
- [ ] Razorpay keys configured
- [ ] CORS origin updated
- [ ] QR codes generated
- [ ] Test end-to-end print job

---

## What Gets Deployed

**Frontend (Vercel):**
- ✅ Next.js app code
- ✅ UI components
- ✅ WebSocket client
- ❌ node_modules (installed fresh)

**Backend (Railway):**
- ✅ Express API
- ✅ WebSocket server
- ✅ Job assignment
- ✅ Printer management
- ❌ pi_client/ (separate, deploy manually to Pi)
- ❌ Development files
- ❌ Tests
- ❌ Docs

---

## Local Development (Still Works!)

Everything locally continues to work:
- `npm run dev` for frontend
- `npm run dev` for backend
- All dev files, tests, docs available
- pi_client/ still there for Pi development

---

## Costs

- **Vercel**: $0 (free tier fine for this)
- **Railway**: $5-10/month (PostgreSQL + app)
- **Razorpay**: Per transaction (2% + ₹0.47)

---

## Ready? Deploy now!
