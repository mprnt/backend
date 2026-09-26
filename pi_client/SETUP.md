# Raspberry Pi Printer Client - Setup Guide

## Prerequisites

- Raspberry Pi 4B or higher (2GB RAM minimum)
- Raspbian/Debian OS
- USB printer connected to Pi
- Network connection to backend server
- Python 3.8+

## Step 1: Install Dependencies

```bash
# Update system
sudo apt update
sudo apt upgrade -y

# Install Python and CUPS
sudo apt install -y python3 python3-pip cups cups-client ghostscript

# Add pi user to lpadmin group
sudo usermod -a -G lpadmin pi

# Install Python dependencies
pip3 install -r requirements.txt
```

## Step 2: Configure CUPS Printer

```bash
# Check connected printers
lpstat -p -d

# Print test page
echo "Test page" | lp -d PRINTER_NAME

# Access CUPS web interface (optional)
# http://raspberry-pi-ip:631
```

**Find your printer name:**
```bash
lpstat -p -d | grep -i "device for"
# Output example: device for Brother_HL_L2350DW: usb://Brother/HL-L2350DW%20series
```

## Step 3: Configure Pi Client

```bash
# Navigate to client directory
cd pi_client

# Copy example config
cp .env.example .env

# Edit configuration
nano .env
```

**Key configurations to update:**

```env
# Set your backend API URL
API_BASE_URL=https://api.mprnt.app/api/v1

# Unique printer ID (use something descriptive)
PRINTER_ID=PI_LIBFLOOR_01

# Kiosk ID (must match your kiosk)
KIOSK_ID=KIOSK001

# Printer name (for display)
PRINTER_NAME=Library Ground Floor Printer

# Your Pi's IP address
PRINTER_IP=192.168.1.100

# CUPS printer name (from lpstat output above)
CUPS_PRINTER_NAME=Brother_HL_L2350DW

# Enable/disable color and double-sided
SUPPORTS_COLOR=true
SUPPORTS_DOUBLE_SIDED=true

# Debug mode
DEBUG=false
```

## Step 4: Run the Client

**Manual test:**
```bash
python3 client.py
```

Expected output:
```
2026-09-26 10:00:00 - __main__ - INFO - 🖨️ Initializing Printer Client
2026-09-26 10:00:00 - __main__ - INFO -    Printer ID: PI_LIBFLOOR_01
2026-09-26 10:00:01 - __main__ - INFO - ✓ Printer registered successfully
2026-09-26 10:00:01 - __main__ - INFO - ♥ Starting heartbeat loop (interval: 30s)
2026-09-26 10:00:01 - __main__ - INFO - 📋 Starting job polling loop (interval: 5s)
2026-09-26 10:00:01 - __main__ - INFO - ✓ Ready! Waiting for print jobs...
```

## Step 5: Setup as System Service (Persistent)

Create systemd service:

```bash
sudo nano /etc/systemd/system/mprnt-printer.service
```

Add the following:

```ini
[Unit]
Description=MPrnt Printer Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/mprnt-backend/pi_client
ExecStart=/usr/bin/python3 /home/pi/mprnt-backend/pi_client/client.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start service:

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable on startup
sudo systemctl enable mprnt-printer

# Start service
sudo systemctl start mprnt-printer

# Check status
sudo systemctl status mprnt-printer

# View logs
sudo journalctl -u mprnt-printer -f
```

## Step 6: Generate QR Codes

For each printer, generate a QR code that links to:

```
https://app.mprnt.app/?kioskId=KIOSK001
```

Use any QR code generator:
- Online: https://qr-server.com/
- CLI: `qrencode -o printer_qr.png "https://app.mprnt.app/?kioskId=KIOSK001"`

Print and place QR codes on each printer.

## Troubleshooting

### Check if printer is registered:
```bash
# Check logs
sudo journalctl -u mprnt-printer -n 20

# Check API directly
curl http://localhost:3000/api/v1/setup/kiosks
```

### Test CUPS printing:
```bash
# List printers
lpstat -p -d

# Print test page
echo "Test" | lp -d Brother_HL_L2350DW

# Check print queue
lpq -P Brother_HL_L2350DW
```

### Common issues:

**"Cannot connect to API"**
- Check backend is running: `curl http://localhost:3000/health`
- Check API_BASE_URL in .env
- Check firewall/network access

**"CUPS printer not found"**
- Verify printer is connected: `lpstat -p -d`
- Check CUPS_PRINTER_NAME in .env
- Restart CUPS: `sudo systemctl restart cups`

**"Permission denied"**
- Add pi to lpadmin: `sudo usermod -a -G lpadmin pi`
- Create log directory: `sudo mkdir -p /var/log/mprnt && sudo chown pi /var/log/mprnt`

**"Print job fails"**
- Check PDF is valid
- Test with manual print: `lp -d PRINTER test.pdf`
- Check printer is online: `lpstat -p -d`

## Monitoring

Check printer status:
```bash
curl http://localhost:3000/api/v1/printer/stats?printerId=PI_LIBFLOOR_01
```

View real-time logs:
```bash
sudo journalctl -u mprnt-printer -f
```

## Production Checklist

- [ ] CUPS printer configured and tested
- [ ] .env file updated with correct values
- [ ] Service created and auto-starts
- [ ] Logs directed to /var/log
- [ ] Network access verified
- [ ] QR codes generated and placed
- [ ] Test print job works end-to-end
- [ ] Heartbeat visible in backend logs
- [ ] Frontend shows printer as "Online"

## Next Steps

1. Generate QR codes for this printer
2. Place QR codes on printer
3. Test by scanning and printing
4. Monitor logs for issues
5. Deploy to other printers

For support, check logs:
```bash
sudo journalctl -u mprnt-printer -f
```
