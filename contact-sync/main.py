#!/usr/bin/env python3
"""
Contact Sync v2.0 - Core Entrypoint
Synchronizes Google Contacts & Square Customers into a strictly canonical engine.
"""

# Triggering build for renamed image
import os
import sys
import argparse
import threading
import time
from dotenv import load_dotenv

from sync_engine import SyncEngine
from google_connector import GoogleContactsConnector
from square_connector import SquareConnector, SQUARE_AVAILABLE
from webhook_handler import WebhookServer

def load_config():
    """Load configuration from .env files, prioritizing specific ones."""
    env_files = [
        os.path.join(os.getcwd(), '.env'),
        os.path.join(os.getcwd(), 'env_files', '.env'),
    ]
    for env_file in env_files:
        if os.path.exists(env_file):
            load_dotenv(env_file)
            print(f"Loaded config from {env_file}")

def setup_connectors(engine):
    """Setup and configure sync connectors based on env vars."""
    print("Setting up connectors...")

    contact_sync_enable_square = os.getenv(
        'CONTACT_SYNC_ENABLE_SQUARE',
        os.getenv('ENABLE_SQUARE', 'false')
    ).lower() == 'true'
    
    # 1. Google Contacts
    if os.getenv('ENABLE_GOOGLE', 'true').lower() == 'true':
        try:
            cred_file = os.getenv('GOOGLE_CREDENTIALS_FILE', 'credentials.json')
            token_file = os.getenv('GOOGLE_TOKEN_FILE', 'token.json')
            
            google_conn = GoogleContactsConnector(
                credentials_file=cred_file,
                token_file=token_file
            )
            engine.register_connector('google', google_conn)
            print("  ✓ Google Contacts connector registered")
        except Exception as e:
            print(f"  ✗ Warning: Could not setup Google connector: {e}")

    # 2. Square
    if SQUARE_AVAILABLE and contact_sync_enable_square:
        try:
            access_token = os.getenv('SQUARE_ACCESS_TOKEN')
            square_conn = SquareConnector(access_token=access_token)
            engine.register_connector('square', square_conn)
            print("  ✓ Square connector registered")
        except Exception as e:
            print(f"  ✗ Warning: Could not setup Square connector: {e}")
    else:
        print("  - Square connector disabled for contact-sync")

def run_sync_loop(engine, interval_secs):
    """Background thread to perform periodic full-sync loops."""
    print(f"Periodic sync thread started (Interval: {interval_secs}s)")
    while True:
        try:
            engine.sync_all()
        except Exception as e:
            print(f"Error in scheduled sync loop: {e}")
            
        time.sleep(interval_secs)

def serve():
    """Run the unified V2 Sync Server process."""
    print("\n============================================================")
    print("STARTING UNIFIED SYNC SERVER v2.4.0")
    print("============================================================\n")
    
    engine = SyncEngine()
    setup_connectors(engine)
    
    # Start background polling loop via thread
    interval = int(os.getenv('SYNC_INTERVAL', '1800'))
    t = threading.Thread(target=run_sync_loop, args=(engine, interval), daemon=True)
    t.start()
    
    # Start the Flask webhook listeners blocking the main thread
    port = int(os.getenv('PORT', '4310'))
    server = WebhookServer(engine, port=port)
    server.run(host='0.0.0.0')

def manual_sync():
    """Run a single foreground sync."""
    engine = SyncEngine()
    setup_connectors(engine)
    engine.sync_all()

if __name__ == '__main__':
    load_config()
    
    parser = argparse.ArgumentParser(description='Contact Sync v2.0')
    parser.add_argument('command', choices=['serve', 'sync'], help='Command to execute. serve: start daemon. sync: single pass.')
    args, unknown = parser.parse_known_args()
    
    if args.command == 'serve':
        serve()
    elif args.command == 'sync':
        manual_sync()
