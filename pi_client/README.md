# MPrnt Raspberry Pi Printer Client

Production-ready Python client for managing print jobs on Raspberry Pi printers connected to the MPrnt backend.

## Features

✅ **Automatic Registration** - Printer auto-registers on startup  
✅ **Heartbeat Monitoring** - Periodic health checks (30s interval)  
✅ **Job Polling** - Efficient job fetching (5s interval)  
✅ **Real-time Status Updates** - Tracks printing progress  
✅ **CUPS Integration** - Works with any CUPS-compatible printer  
✅ **Error Handling** - Graceful error recovery and retry logic  
✅ **Comprehensive Logging** - Detailed logs for debugging  
✅ **Systemd Service** - Runs as background service on boot  

## Architecture

```
Raspberry Pi
    ↓
[Client Process]
    ├─ Heartbeat Thread (every 30s)
    │   └─ POST /printer/heartbeat
    │
    └─ Job Polling Thread (every 5s)
        ├─ GET /printer/next-job
        ├─ Download PDF
        ├─ Print via CUPS
        └─ POST /printer/job-status
            ↓
        Backend API
            ↓
        Frontend Updates (WebSocket)
```

## Quick Start

### 1. Automated Setup (Recommended)

```bash
cd pi_client
chmod +x deploy.sh
./deploy.sh
```

Then edit configuration:
```bash
nano .env
```

### 2. Manual Setup

```bash
# Install dependencies
sudo apt install -y python3 python3-pip cups cups-client ghostscript
pip3 install -r requirements.txt

# Copy configuration
cp .env.example .env
nano .env

# Run client
python3 client.py
```

### 3. Setup as Service

```bash
sudo systemctl start mprnt-printer
sudo systemctl status mprnt-printer
sudo journalctl -u mprnt-printer -f
```

## Configuration

Edit `.env` file with your printer details:

```env
# Backend API
API_BASE_URL=https://api.mprnt.app/api/v1

# Printer Identity
PRINTER_ID=PI_LIBFLOOR_01           # Unique printer ID
KIOSK_ID=KIOSK001                   # Kiosk this printer belongs to
PRINTER_NAME=Library Ground Floor   # Display name
PRINTER_IP=192.168.1.100            # This printer's IP

# Capabilities
SUPPORTS_COLOR=true
SUPPORTS_DOUBLE_SIDED=true
MAX_COPIES=100
SUPPORTED_PAPER_SIZES=a4,letter

# CUPS Printer Name (run: lpstat -p -d)
CUPS_PRINTER_NAME=Brother_HL_L2350DW

# Intervals (seconds)
HEARTBEAT_INTERVAL=30
JOB_POLL_INTERVAL=5
STATUS_UPDATE_INTERVAL=2

# Logging
LOG_FILE=/var/log/mprnt/printer.log
TEMP_DIR=/tmp/mprnt

# Timeouts
REQUEST_TIMEOUT=10
PRINT_TIMEOUT=600

# Retries
MAX_RETRIES=3
RETRY_DELAY=5

# Debug
DEBUG=false
```

## Finding Your CUPS Printer Name

```bash
# List all printers
lpstat -p -d

# Output example:
# device for Brother_HL_L2350DW: usb://Brother/HL-L2350DW%20series
# Copy: Brother_HL_L2350DW
```

## Running

### Interactive Mode
```bash
python3 client.py
```

### As Service
```bash
sudo systemctl start mprnt-printer
sudo systemctl enable mprnt-printer  # Auto-start on boot
```

### View Logs
```bash
# Real-time logs
sudo journalctl -u mprnt-printer -f

# Last 50 lines
sudo journalctl -u mprnt-printer -n 50

# Today's logs
sudo journalctl -u mprnt-printer --since today
```

## How It Works

### 1. Registration (On Startup)
```
Client sends printer capabilities to backend
Backend registers printer as 'online'
Client starts heartbeat and job polling
```

### 2. Heartbeat (Every 30 seconds)
```
Client sends: POST /printer/heartbeat
Backend updates: last_heartbeat = NOW()
Backend status: 'online'

If no heartbeat for 5 min → status = 'offline'
```

### 3. Job Polling (Every 5 seconds)
```
Client polls: GET /printer/next-job
Backend returns: Next assigned job or null
If job exists:
  - Download PDF
  - Print via CUPS
  - Track progress
  - Update status in real-time
```

### 4. Printing
```
Job starts
  ↓
Update: status='printing', pages=1
  ↓
Backend broadcasts via WebSocket
  ↓
Frontend shows: "Printing... Page 1 of 5"
  ↓
[Repeat for each page]
  ↓
All done
  ↓
Update: status='completed', pages=5
  ↓
Frontend shows: "Done! Collect from printer"
```

## API Endpoints Used

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/printer/register` | Register printer on startup |
| POST | `/printer/heartbeat` | Send heartbeat (30s) |
| GET | `/printer/next-job` | Poll for jobs (5s) |
| GET | `/print-jobs/{id}` | Get job details |
| GET | `/documents/{id}/file` | Download PDF |
| POST | `/printer/job-status` | Update job status |

## Monitoring & Troubleshooting

### Check Printer Status
```bash
curl http://localhost:3000/api/v1/printer/stats?printerId=PI_LIBFLOOR_01
```

### Test CUPS Printing
```bash
# List printers
lpstat -p -d

# Print test page
echo "Test page" | lp -d Brother_HL_L2350DW

# Check print queue
lpq -P Brother_HL_L2350DW
```

### Common Issues

**"Cannot connect to API"**
- Check backend is running: `curl http://localhost:3000/health`
- Verify `API_BASE_URL` in `.env`
- Check network connectivity

**"Printer not found"**
- Run: `lpstat -p -d | grep device`
- Update `CUPS_PRINTER_NAME` in `.env`
- Restart service: `sudo systemctl restart mprnt-printer`

**"Print job fails"**
- Check logs: `sudo journalctl -u mprnt-printer -f`
- Test manual print: `lp -d PRINTER test.pdf`
- Verify printer is online and has paper/toner

**"Service won't start"**
- Check logs: `sudo journalctl -u mprnt-printer -n 20`
- Verify Python path: `which python3`
- Check file permissions: `ls -la client.py`

## Files

```
pi_client/
├── client.py              # Main client application
├── config.py              # Configuration management
├── requirements.txt       # Python dependencies
├── .env.example          # Example configuration
├── deploy.sh             # Automated deployment script
├── SETUP.md              # Detailed setup guide
└── README.md             # This file
```

## Performance Notes

- **Memory Usage**: ~30-50 MB
- **CPU Usage**: <1% idle, 5-10% during printing
- **Network**: Minimal (small HTTP requests)
- **Polling Overhead**: ~0.5s every 5 seconds

## Security Considerations

- Run as unprivileged user (not root)
- Use HTTPS in production
- Restrict API access via firewall
- Keep logs private (contain job info)
- Rotate logs regularly

## Logs

Logs are written to:
- **Console**: Standard output during `python3 client.py`
- **File**: `/var/log/mprnt/printer.log`
- **Systemd Journal**: `journalctl -u mprnt-printer`

Log format:
```
2026-09-26 10:00:00 - __main__ - INFO - ♥ Heartbeat sent
2026-09-26 10:00:05 - __main__ - INFO - 📥 New job available: 550e8400-e29b...
2026-09-26 10:00:10 - __main__ - INFO - 🖨️ Starting print job
```

## Support

For issues or questions:
1. Check logs: `sudo journalctl -u mprnt-printer -f`
2. Verify configuration: `nano .env`
3. Test CUPS: `lpstat -p -d`
4. Review this README

## License

MPrnt © 2026
