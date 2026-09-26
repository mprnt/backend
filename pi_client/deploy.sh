#!/bin/bash
# Deployment script for Raspberry Pi Printer Client

set -e

echo "🚀 MPrnt Printer Client Deployment Script"
echo "=========================================="

# Check if running on Raspberry Pi
if ! grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
    echo "⚠️  Warning: This doesn't appear to be a Raspberry Pi"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if running as root for system setup
if [ "$EUID" -ne 0 ]; then
    echo "⚠️  Some commands require sudo"
fi

# Step 1: Update system
echo ""
echo "📦 Updating system packages..."
sudo apt update
sudo apt upgrade -y

# Step 2: Install dependencies
echo ""
echo "📦 Installing dependencies..."
sudo apt install -y python3 python3-pip cups cups-client ghostscript

# Step 3: Add user to lpadmin group
echo ""
echo "👤 Configuring user permissions..."
sudo usermod -a -G lpadmin $(whoami)
echo "   Added $(whoami) to lpadmin group"

# Step 4: Install Python packages
echo ""
echo "🐍 Installing Python packages..."
pip3 install -q -r requirements.txt
echo "   ✓ Python packages installed"

# Step 5: Detect printer
echo ""
echo "🖨️  Detected printers:"
lpstat -p -d | grep "device for" || echo "   No printers found yet"

# Step 6: Create config from template
if [ ! -f .env ]; then
    echo ""
    echo "⚙️  Creating configuration file..."
    cp .env.example .env
    echo "   Created .env - please edit with your settings"
    echo "   nano .env"
else
    echo ""
    echo "✓ Configuration file already exists"
fi

# Step 7: Setup logging directory
echo ""
echo "📝 Setting up logging..."
mkdir -p /var/log/mprnt
sudo chown $(whoami) /var/log/mprnt
echo "   ✓ Log directory created"

# Step 8: Create systemd service
echo ""
echo "⚙️  Creating systemd service..."

SERVICE_FILE="/etc/systemd/system/mprnt-printer.service"
CLIENT_DIR="$(pwd)"

cat > /tmp/mprnt-printer.service << EOF
[Unit]
Description=MPrnt Printer Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$CLIENT_DIR
ExecStart=/usr/bin/python3 $CLIENT_DIR/client.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
EOF

sudo cp /tmp/mprnt-printer.service $SERVICE_FILE
echo "   ✓ Service file created"

# Step 9: Enable service
echo ""
echo "🔧 Configuring systemd..."
sudo systemctl daemon-reload
sudo systemctl enable mprnt-printer
echo "   ✓ Service enabled (will start on boot)"

# Step 10: Final instructions
echo ""
echo "=========================================="
echo "✅ Installation Complete!"
echo "=========================================="
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Edit configuration:"
echo "   nano .env"
echo ""
echo "2. Find your CUPS printer name:"
echo "   lpstat -p -d | grep device"
echo ""
echo "3. Start the service:"
echo "   sudo systemctl start mprnt-printer"
echo ""
echo "4. Check status:"
echo "   sudo systemctl status mprnt-printer"
echo ""
echo "5. View logs:"
echo "   sudo journalctl -u mprnt-printer -f"
echo ""
echo "6. Test with a print job!"
echo ""
