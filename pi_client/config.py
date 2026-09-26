"""
Configuration for Raspberry Pi Printer Client
"""

import os
from dotenv import load_dotenv

load_dotenv()

# API Configuration
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:3000/api/v1")

# Printer Configuration
PRINTER_ID = os.getenv("PRINTER_ID", "PI_001")
KIOSK_ID = os.getenv("KIOSK_ID", "KIOSK001")
PRINTER_NAME = os.getenv("PRINTER_NAME", "Raspberry Pi Printer")
PRINTER_IP = os.getenv("PRINTER_IP", "192.168.1.100")

# Printer Capabilities
SUPPORTS_COLOR = os.getenv("SUPPORTS_COLOR", "true").lower() == "true"
SUPPORTS_DOUBLE_SIDED = os.getenv("SUPPORTS_DOUBLE_SIDED", "true").lower() == "true"
MAX_COPIES = int(os.getenv("MAX_COPIES", "100"))
SUPPORTED_PAPER_SIZES = os.getenv("SUPPORTED_PAPER_SIZES", "a4,letter").split(",")

# CUPS Printer Name (local printer name in CUPS)
CUPS_PRINTER_NAME = os.getenv("CUPS_PRINTER_NAME", "Brother_HL_L2350DW")

# Polling Configuration
HEARTBEAT_INTERVAL = int(os.getenv("HEARTBEAT_INTERVAL", "30"))  # seconds
JOB_POLL_INTERVAL = int(os.getenv("JOB_POLL_INTERVAL", "5"))  # seconds
STATUS_UPDATE_INTERVAL = int(os.getenv("STATUS_UPDATE_INTERVAL", "2"))  # seconds during printing

# File Configuration
TEMP_DIR = os.getenv("TEMP_DIR", "/tmp/mprnt")
LOG_FILE = os.getenv("LOG_FILE", "/var/log/mprnt_printer.log")

# Timeouts
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "10"))  # seconds
PRINT_TIMEOUT = int(os.getenv("PRINT_TIMEOUT", "600"))  # seconds (10 minutes)

# Retry Configuration
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RETRY_DELAY = int(os.getenv("RETRY_DELAY", "5"))  # seconds

# Debug
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
