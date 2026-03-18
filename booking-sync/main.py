"""
Core sync engine for Square to Google Calendar.
"""
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Dict

from booking_model import Booking
from square_booking_connector import SquareBookingConnector
from google_calendar_connector import GoogleCalendarConnector


import argparse
import threading

class SyncEngine:
    """Orchestrates the sync between Square and Google Calendar."""
    
    def __init__(self, square_token: str = None, google_creds: str = 'credentials.json', google_token: str = 'token.json'):
        self.square = SquareBookingConnector(square_token)
        self.google = GoogleCalendarConnector(google_creds, google_token)
        
        # Cache for performance
        self.customer_cache = {}
        self.service_cache = {}
        
    def sync_upcoming(self):
        """Perform a full sync of upcoming bookings."""
        print(f"[{datetime.now()}] Starting Square to Google Calendar sync...")
        
        try:
            # 1. Fetch upcoming Square bookings
            square_bookings = self.square.fetch_upcoming_bookings()
            
            # 2. Fetch existing Google events to find matches and avoid duplicates
            # We look for events with our private property 'square_booking_id'
            google_events = self.google.fetch_events()
            
            # Map square_id -> google_event_id
            existing_mapping = {}
            for event in google_events:
                props = event.get('extendedProperties', {}).get('private', {})
                sq_id = props.get('square_booking_id')
                if sq_id:
                    existing_mapping[sq_id] = event.get('id')
            
            # 3. Process Square bookings
            for booking in square_bookings:
                # Enrich with customer/service details
                self._enrich_booking(booking)
                
                # Check mapping
                if booking.booking_id in existing_mapping:
                    booking.google_event_id = existing_mapping[booking.booking_id]
                    # Check if summary or start_at changed? 
                    # For simplicity, we just upsert. Google API update is efficient.
                
                # Upsert to Google
                new_event_id = self.google.upsert_booking_as_event(booking)
                booking.google_event_id = new_event_id
                
            print(f"[{datetime.now()}] Sync completed successfully.")
            
        except Exception as e:
            print(f"Error during sync: {e}")
            
    def _enrich_booking(self, booking: Booking):
        """Enrich booking with names from Square."""
        # Customer
        if booking.customer_id:
            if booking.customer_id not in self.customer_cache:
                cust = self.square.get_customer_details(booking.customer_id)
                self.customer_cache[booking.customer_id] = cust
            
            cust_data = self.customer_cache[booking.customer_id]
            booking.customer_name = f"{cust_data.get('given_name', '')} {cust_data.get('family_name', '')}".strip() or "Customer"
            booking.customer_phone = cust_data.get('phone_number')
            
            # Address formatting
            addr = cust_data.get('address', {})
            addr_parts = [
                addr.get('address_line_1'),
                addr.get('address_line_2'),
                addr.get('locality'), # City
                addr.get('administrative_district_level_1'), # State
                addr.get('postal_code')
            ]
            booking.customer_address = ", ".join([p for p in addr_parts if p]).strip()
            
        # Service
        if booking.service_id:
            if booking.service_id not in self.service_cache:
                svc = self.square.get_service_details(booking.service_id)
                # Catalog object 'item_variation_data' -> item_id or directly variation name?
                # Usually we want the item name.
                variation_data = svc.get('item_variation_data', {})
                name = variation_data.get('name', 'Service')
                self.service_cache[booking.service_id] = name
            booking.service_name = self.service_cache[booking.service_id]

def run_sync_loop(engine, interval_secs):
    """Background thread to perform periodic full-sync loops."""
    print(f"Periodic sync thread started (Interval: {interval_secs}s)")
    while True:
        try:
            engine.sync_upcoming()
        except Exception as e:
            print(f"Error in scheduled sync loop: {e}")
            
        time.sleep(interval_secs)

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    
    parser = argparse.ArgumentParser(description='Booking Sync v1.0')
    parser.add_argument('command', choices=['serve', 'sync'], help='Command to execute. serve: start daemon. sync: single pass.')
    args, unknown = parser.parse_known_args()
    
    # Configuration from environment
    sq_token = os.getenv('SQUARE_ACCESS_TOKEN')
    cred_file = os.getenv('GOOGLE_CREDENTIALS_FILE', '/app/env_files/credentials.json')
    token_file = os.getenv('GOOGLE_TOKEN_FILE', '/app/env_files/token.json')
    
    engine = SyncEngine(sq_token, cred_file, token_file)
    
    if args.command == 'serve':
        interval = int(os.getenv('SYNC_INTERVAL', '3600')) # Every hour by default
        run_sync_loop(engine, interval)
    elif args.command == 'sync':
        engine.sync_upcoming()

