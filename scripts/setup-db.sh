#!/bin/bash

# Database setup script
# This script initializes the PostgreSQL database with the required schema

set -e

echo "Setting up MPrnt database..."

# Load environment variables
source .env 2>/dev/null || echo "Warning: .env file not found"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-mprnt}"
DB_USER="${DB_USER:-mprnt_user}"

echo "Database configuration:"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"

# Check if PostgreSQL is running
if ! pg_isready -h $DB_HOST -p $DB_PORT -U $DB_USER &> /dev/null; then
  echo "Error: PostgreSQL is not running or not accessible"
  exit 1
fi

echo "PostgreSQL is running"

# Create database if it doesn't exist
psql -h $DB_HOST -p $DB_PORT -U $DB_USER -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || \
  psql -h $DB_HOST -p $DB_PORT -U $DB_USER -c "CREATE DATABASE $DB_NAME"

echo "Database '$DB_NAME' is ready"

# TODO: Run migrations or schema setup here
# psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f schema.sql

echo "Database setup completed successfully!"
