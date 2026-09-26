"""
Main Raspberry Pi Printer Client
Handles registration, job polling, printing, and status updates
"""

import os
import sys
import time
import requests
import threading
import logging
import subprocess
from datetime import datetime
from typing import Optional, Dict, Any
from pathlib import Path

from config import (
    API_BASE_URL, PRINTER_ID, KIOSK_ID, PRINTER_NAME, PRINTER_IP,
    SUPPORTS_COLOR, SUPPORTS_DOUBLE_SIDED, MAX_COPIES, SUPPORTED_PAPER_SIZES,
    CUPS_PRINTER_NAME, HEARTBEAT_INTERVAL, JOB_POLL_INTERVAL,
    STATUS_UPDATE_INTERVAL, TEMP_DIR, LOG_FILE, REQUEST_TIMEOUT,
    PRINT_TIMEOUT, MAX_RETRIES, RETRY_DELAY, DEBUG
)

# Setup logging
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE) if LOG_FILE else logging.NullHandler()
    ]
)
logger = logging.getLogger(__name__)

# Ensure temp directory exists
Path(TEMP_DIR).mkdir(parents=True, exist_ok=True)


class PrinterClient:
    """Raspberry Pi Printer Client"""

    def __init__(self):
        self.printer_id = PRINTER_ID
        self.kiosk_id = KIOSK_ID
        self.api_base = API_BASE_URL
        self.is_running = True
        self.current_job = None

        logger.info(f"🖨️ Initializing Printer Client")
        logger.info(f"   Printer ID: {self.printer_id}")
        logger.info(f"   Kiosk ID: {self.kiosk_id}")
        logger.info(f"   API Base: {self.api_base}")

    def register(self) -> bool:
        """Register printer with backend"""
        try:
            payload = {
                "printerId": self.printer_id,
                "kioskId": self.kiosk_id,
                "name": PRINTER_NAME,
                "ipAddress": PRINTER_IP,
                "capabilities": {
                    "supportsColor": SUPPORTS_COLOR,
                    "supportsDoubleSided": SUPPORTS_DOUBLE_SIDED,
                    "maxCopies": MAX_COPIES,
                    "supportedPaperSizes": SUPPORTED_PAPER_SIZES,
                }
            }

            response = requests.post(
                f"{self.api_base}/printer/register",
                json=payload,
                timeout=REQUEST_TIMEOUT
            )

            if response.status_code in [200, 201]:
                logger.info("✓ Printer registered successfully")
                return True
            else:
                logger.error(f"✗ Registration failed: {response.status_code}")
                logger.error(f"  Response: {response.text}")
                return False

        except Exception as e:
            logger.error(f"✗ Registration error: {e}")
            return False

    def send_heartbeat(self) -> bool:
        """Send heartbeat to indicate printer is online"""
        try:
            payload = {"printerId": self.printer_id}
            response = requests.post(
                f"{self.api_base}/printer/heartbeat",
                json=payload,
                timeout=REQUEST_TIMEOUT
            )

            if response.status_code == 200:
                logger.debug("♥ Heartbeat sent")
                return True
            else:
                logger.warning(f"⚠ Heartbeat failed: {response.status_code}")
                return False

        except Exception as e:
            logger.warning(f"⚠ Heartbeat error: {e}")
            return False

    def poll_for_jobs(self) -> Optional[Dict[str, Any]]:
        """Poll for next job to print"""
        try:
            response = requests.get(
                f"{self.api_base}/printer/next-job",
                params={"printerId": self.printer_id},
                timeout=REQUEST_TIMEOUT
            )

            if response.status_code == 200:
                job = response.json().get("data")
                if job:
                    logger.info(f"📥 New job available: {job.get('jobId', 'unknown')}")
                    return job
                return None
            else:
                logger.warning(f"⚠ Job poll failed: {response.status_code}")
                return None

        except Exception as e:
            logger.warning(f"⚠ Job poll error: {e}")
            return None

    def download_document(self, job_id: str) -> Optional[str]:
        """Download print document (PDF)"""
        try:
            logger.info(f"📥 Downloading document for job {job_id}")

            response = requests.get(
                f"{self.api_base}/print-jobs/{job_id}",
                timeout=REQUEST_TIMEOUT
            )

            if response.status_code != 200:
                logger.error(f"✗ Failed to get job details: {response.status_code}")
                return None

            job_data = response.json().get("data")
            if not job_data:
                logger.error("✗ No job data in response")
                return None

            document_id = job_data.get("documentId")
            if not document_id:
                logger.error("✗ No documentId in job")
                return None

            # Download actual file
            file_response = requests.get(
                f"{self.api_base}/documents/{document_id}/file",
                timeout=REQUEST_TIMEOUT
            )

            if file_response.status_code != 200:
                logger.error(f"✗ Failed to download file: {file_response.status_code}")
                return None

            # Save to temp file
            file_path = os.path.join(TEMP_DIR, f"{job_id}.pdf")
            with open(file_path, "wb") as f:
                f.write(file_response.content)

            logger.info(f"✓ Document downloaded: {file_path}")
            return file_path

        except Exception as e:
            logger.error(f"✗ Download error: {e}")
            return None

    def print_document(self, job: Dict[str, Any], file_path: str) -> bool:
        """Print document using CUPS"""
        try:
            job_id = job.get("jobId")
            total_pages = job.get("totalPages", 1)

            logger.info(f"🖨️ Starting print job: {job_id}")
            logger.info(f"   Pages: {total_pages}")
            logger.info(f"   Color: {'Yes' if job.get('colorMode') == 'color' else 'No'}")
            logger.info(f"   Double-sided: {'Yes' if job.get('doubleSided') else 'No'}")

            # Update status: printing
            self.update_job_status(job_id, "printing", 0)

            # Build CUPS command
            # Example: lp -d printer_name -o Duplex=DuplexNoTumble -o ColorModel=Color file.pdf
            cmd = [
                "lp",
                "-d", CUPS_PRINTER_NAME,
                file_path
            ]

            # Add options based on job settings
            if job.get("colorMode") == "color":
                cmd.insert(2, "-o")
                cmd.insert(3, "ColorModel=Color")
            else:
                cmd.insert(2, "-o")
                cmd.insert(3, "ColorModel=Grayscale")

            if job.get("doubleSided"):
                cmd.insert(2, "-o")
                cmd.insert(3, "Duplex=DuplexNoTumble")

            # Execute print command
            logger.debug(f"   Command: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, timeout=PRINT_TIMEOUT, text=True)

            if result.returncode != 0:
                error_msg = result.stderr or "Unknown error"
                logger.error(f"✗ Print command failed: {error_msg}")
                self.update_job_status(job_id, "failed", 0, error_msg)
                return False

            logger.info(f"✓ Print job submitted to CUPS")

            # Simulate page tracking (in real implementation, read from printer status)
            for page in range(1, total_pages + 1):
                time.sleep(STATUS_UPDATE_INTERVAL)
                self.update_job_status(job_id, "printing", page)
                logger.info(f"   Printed {page}/{total_pages} pages")

            # Mark as completed
            self.update_job_status(job_id, "completed", total_pages)
            logger.info(f"✓ Print job completed: {job_id}")

            return True

        except subprocess.TimeoutExpired:
            logger.error(f"✗ Print job timed out")
            self.update_job_status(job.get("jobId"), "failed", 0, "Print timeout")
            return False
        except Exception as e:
            logger.error(f"✗ Print error: {e}")
            self.update_job_status(job.get("jobId"), "failed", 0, str(e))
            return False

    def update_job_status(
        self,
        job_id: str,
        status: str,
        printed_pages: int = 0,
        error_message: str = None
    ) -> bool:
        """Update job status on backend"""
        try:
            payload = {
                "jobId": job_id,
                "status": status,
                "printedPages": printed_pages,
            }

            if error_message:
                payload["errorMessage"] = error_message

            response = requests.post(
                f"{self.api_base}/printer/job-status",
                json=payload,
                timeout=REQUEST_TIMEOUT
            )

            if response.status_code == 200:
                logger.debug(f"📍 Status updated: {status}")
                return True
            else:
                logger.warning(f"⚠ Status update failed: {response.status_code}")
                return False

        except Exception as e:
            logger.warning(f"⚠ Status update error: {e}")
            return False

    def process_job(self, job: Dict[str, Any]) -> None:
        """Process a single print job"""
        try:
            job_id = job.get("jobId")
            self.current_job = job_id

            logger.info(f"\n{'='*60}")
            logger.info(f"Processing job: {job_id}")
            logger.info(f"{'='*60}")

            # Download document
            file_path = self.download_document(job_id)
            if not file_path:
                self.update_job_status(job_id, "failed", 0, "Download failed")
                return

            # Print document
            success = self.print_document(job, file_path)

            # Cleanup
            try:
                os.remove(file_path)
                logger.debug(f"✓ Cleaned up temp file: {file_path}")
            except Exception as e:
                logger.warning(f"⚠ Failed to cleanup temp file: {e}")

            self.current_job = None

        except Exception as e:
            logger.error(f"✗ Job processing error: {e}")
            self.current_job = None

    def heartbeat_loop(self) -> None:
        """Send heartbeat at regular intervals"""
        logger.info(f"♥ Starting heartbeat loop (interval: {HEARTBEAT_INTERVAL}s)")

        while self.is_running:
            try:
                self.send_heartbeat()
                time.sleep(HEARTBEAT_INTERVAL)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"✗ Heartbeat loop error: {e}")
                time.sleep(HEARTBEAT_INTERVAL)

    def job_polling_loop(self) -> None:
        """Poll for jobs at regular intervals"""
        logger.info(f"📋 Starting job polling loop (interval: {JOB_POLL_INTERVAL}s)")

        while self.is_running:
            try:
                job = self.poll_for_jobs()
                if job:
                    self.process_job(job)

                time.sleep(JOB_POLL_INTERVAL)
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"✗ Job polling error: {e}")
                time.sleep(JOB_POLL_INTERVAL)

    def run(self) -> None:
        """Start the printer client"""
        logger.info("🚀 Starting Printer Client")

        # Register with backend
        for attempt in range(MAX_RETRIES):
            if self.register():
                break
            if attempt < MAX_RETRIES - 1:
                logger.info(f"⏳ Retrying registration in {RETRY_DELAY}s...")
                time.sleep(RETRY_DELAY)
        else:
            logger.error("✗ Failed to register after retries")
            return

        # Start background threads
        heartbeat_thread = threading.Thread(
            target=self.heartbeat_loop,
            name="HeartbeatThread",
            daemon=True
        )
        heartbeat_thread.start()
        logger.info("✓ Heartbeat thread started")

        # Start job polling (main thread)
        try:
            logger.info("✓ Ready! Waiting for print jobs...")
            self.job_polling_loop()
        except KeyboardInterrupt:
            logger.info("\n⏹ Shutting down...")
            self.is_running = False
            heartbeat_thread.join(timeout=2)
            logger.info("✓ Printer client stopped")


def main():
    """Main entry point"""
    try:
        client = PrinterClient()
        client.run()
    except Exception as e:
        logger.error(f"✗ Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
