#!/usr/bin/env python3
"""
Quick test script to verify Raspberry Pi client setup
Run this to diagnose issues
"""

import requests
import subprocess
import sys
from pathlib import Path

def test_api_connection(api_url):
    """Test backend API connection"""
    print("🔍 Testing API connection...")
    try:
        response = requests.get(f"{api_url}/health", timeout=5)
        if response.status_code == 200:
            print("   ✓ API is reachable")
            return True
        else:
            print(f"   ✗ API returned {response.status_code}")
            return False
    except Exception as e:
        print(f"   ✗ Cannot reach API: {e}")
        return False

def test_cups_printer(printer_name):
    """Test CUPS printer"""
    print(f"🔍 Testing CUPS printer: {printer_name}")
    try:
        result = subprocess.run(
            ["lpstat", "-p", "-d"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if printer_name in result.stdout:
            print("   ✓ Printer is available in CUPS")
            return True
        else:
            print(f"   ✗ Printer not found")
            print(f"   Available: {result.stdout}")
            return False
    except Exception as e:
        print(f"   ✗ CUPS error: {e}")
        return False

def test_temp_directory(temp_dir):
    """Test temp directory"""
    print(f"🔍 Testing temp directory: {temp_dir}")
    try:
        Path(temp_dir).mkdir(parents=True, exist_ok=True)
        test_file = Path(temp_dir) / ".test"
        test_file.touch()
        test_file.unlink()
        print("   ✓ Temp directory is writable")
        return True
    except Exception as e:
        print(f"   ✗ Cannot write to temp dir: {e}")
        return False

def test_dependencies():
    """Test Python dependencies"""
    print("🔍 Testing Python dependencies...")
    required = ["requests", "dotenv"]
    all_ok = True
    for pkg in required:
        try:
            __import__(pkg.replace("-", "_"))
            print(f"   ✓ {pkg}")
        except ImportError:
            print(f"   ✗ {pkg} not installed")
            all_ok = False
    return all_ok

def check_config():
    """Check .env configuration"""
    print("🔍 Checking configuration...")
    if not Path(".env").exists():
        print("   ✗ .env file not found")
        print("   Create it: cp .env.example .env")
        return False
    print("   ✓ .env file exists")
    return True

def main():
    """Run all tests"""
    print("\n" + "="*50)
    print("MPrnt Printer Client - Diagnostic Test")
    print("="*50 + "\n")

    # Load config
    try:
        from config import (
            API_BASE_URL, CUPS_PRINTER_NAME, TEMP_DIR
        )
    except ImportError:
        print("✗ Cannot load config (missing .env)")
        sys.exit(1)

    results = []

    # Run tests
    results.append(("Config", check_config()))
    results.append(("Dependencies", test_dependencies()))
    results.append(("API Connection", test_api_connection(API_BASE_URL)))
    results.append(("CUPS Printer", test_cups_printer(CUPS_PRINTER_NAME)))
    results.append(("Temp Directory", test_temp_directory(TEMP_DIR)))

    # Summary
    print("\n" + "="*50)
    print("Test Summary")
    print("="*50)

    passed = sum(1 for _, result in results if result)
    total = len(results)

    for name, result in results:
        status = "✓" if result else "✗"
        print(f"{status} {name}")

    print(f"\nResult: {passed}/{total} tests passed")

    if passed == total:
        print("\n✅ All tests passed! Ready to run:")
        print("   python3 client.py")
        sys.exit(0)
    else:
        print("\n⚠️  Some tests failed. Fix issues above and try again.")
        sys.exit(1)

if __name__ == "__main__":
    main()
