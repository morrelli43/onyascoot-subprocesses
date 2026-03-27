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
from flask import Flask, request, jsonify

class WebhookServer:
    """Flask app to receive Square booking webhooks and trigger sync."""
    def __init__(self, engine, port=5001):
        self.app = Flask(__name__)
        self.engine = engine
        self.port = port
        
        # Register routes
        self.app.route('/square-webhook', methods=['POST'])(self.square_webhook)
        self.app.route('/webhooks/square', methods=['POST'])(self.square_webhook)
        self.app.route('/<path:path>', methods=['POST', 'GET'])(self.catch_all)

    def square_webhook(self):
        event = request.json
        print(f"[WEBHOOK] Received event: {event}")
        if event and event.get('type', '').startswith('booking.'):
            print(f"[WEBHOOK] Triggering booking sync for event type: {event.get('type')}")
            
            # Delay the sync slightly to ensure Square's API returns the up-to-date state
            def delayed_sync():
                time.sleep(2)
                self.engine.sync_upcoming()
                
            threading.Thread(target=delayed_sync).start()
        return jsonify({'status': 'ok'})

    def catch_all(self, path):
        print(f"[WEBHOOK-DEBUG] Received request on unknown path: /{path}")
        if request.is_json:
            print(f"[WEBHOOK-DEBUG] Payload: {request.json}")
        return jsonify({'status': 'ignored', 'path': path}), 404

    def run(self, host='0.0.0.0'):
        print(f"\n[WebhookServer] Starting listener on {host}:{self.port}")
        self.app.run(host=host, port=self.port, debug=False)

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
            print(f"[DEBUG] Square bookings fetched: {[b.booking_id for b in square_bookings]}")

            # 2. Fetch existing Google events to find matches and avoid duplicates
            # We look for events with our private property 'square_booking_id'
            google_events = self.google.fetch_events()
            print(f"[DEBUG] Google events fetched: {[e.get('id') for e in google_events]}")

            # Map square_id -> google_event_id
            existing_mapping = {}
            for event in google_events:
                props = event.get('extendedProperties', {}).get('private', {})
                sq_id = props.get('square_booking_id')
                if sq_id:
                    existing_mapping[sq_id] = event.get('id')

            # 3. Process Square bookings
            for booking in square_bookings:
                print(f"[DEBUG] Processing booking: {booking.booking_id}")
                # Enrich with customer/service details
                self._enrich_booking(booking)

                # Check mapping
                if booking.booking_id in existing_mapping:
                    booking.google_event_id = existing_mapping[booking.booking_id]
                    print(f"[DEBUG] Booking {booking.booking_id} already exists in Google, updating event {booking.google_event_id}")
                else:
                    print(f"[DEBUG] Booking {booking.booking_id} does not exist in Google, creating new event")

                # Upsert to Google
                new_event_id = self.google.upsert_booking_as_event(booking)
                booking.google_event_id = new_event_id
                print(f"[DEBUG] Upserted booking {booking.booking_id} as Google event {new_event_id}")

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
            booking.customer_suburb = addr.get('locality') # Suburb/City
            
            addr_parts = [
                addr.get('address_line_1'),
                addr.get('address_line_2'),
                booking.customer_suburb,
                addr.get('administrative_district_level_1'), # State
                addr.get('postal_code')
            ]
            booking.customer_address = ", ".join([p for p in addr_parts if p]).strip()
            
        # Services & Price
        booking.services_list = []
        booking.total_price = 0.0
        
        for svc_id in getattr(booking, 'service_ids', [booking.service_id]):
            if not svc_id: continue
            
            if svc_id not in self.service_cache:
                svc_obj = self.square.get_service_details(svc_id)
                self.service_cache[svc_id] = svc_obj
            
            svc = self.service_cache[svc_id]
            if svc:
                var_data = svc.get('item_variation_data', {})
                parent_name = svc.get('parent_name')
                var_name = var_data.get('name', '')
                
                # Combine parent and variation cleanly
                if parent_name and var_name and var_name.lower() not in ['regular', 'standard', 'base']:
                    name = f"{parent_name} ({var_name})"
                else:
                    name = parent_name or var_name or "Service"
                    
                # Filter out Mobile Callout Fee entirely
                if "mobile callout" not in name.lower():
                    booking.services_list.append(name)
                
                # Price
                price_money = var_data.get('price_money', {})
                if price_money:
                    booking.total_price += float(price_money.get('amount', 0)) / 100.0
        
        # Set primary service name for summary
        if booking.services_list:
            booking.service_name = booking.services_list[0]
            if len(booking.services_list) > 1:
                booking.service_name += f" (+{len(booking.services_list)-1} more)"

        # eScooter Extraction (Prefer eScooter1 custom field)
        escooter = None
        
        # Check custom attributes (now requires a separate call in this SDK version)
        if booking.customer_id:
            attrs = self.square.get_customer_custom_attributes(booking.customer_id)
            if attrs:
                # Look for eScooter1 (key often maps to 'eScooter1' slug)
                # We look for any attribute with "escooter" in the name or key
                for key, attr in attrs.items():
                    if 'escooter' in key.lower():
                        val = attr.get('value') or attr.get('string_value')
                        if val:
                            escooter = val
                            break
        
        # Fallback to extraction from notes
        if not escooter and booking.notes:
            notes_lower = booking.notes.lower()
            
            # Look for specific prefixes
            for prefix in ['scooter:', 'escooter:', 'model:', 'bike:']:
                if prefix in notes_lower:
                    start = notes_lower.find(prefix) + len(prefix)
                    line = booking.notes[start:].split('\n')[0].strip()
                    if line:
                        escooter = line
                        break
            
            # If no prefix, check common brands
            if not escooter:
                brands = ['xiaomi', 'segway', 'ninebot', 'apollo', 'vsett', 'kaabo', 'dualtron', 'innokim', 'unagi', 'niu', 'hiboy', 'gotrax']
                for brand in brands:
                    if brand in notes_lower:
                        for line in booking.notes.split('\n'):
                            if brand in line.lower():
                                escooter = line.strip()
                                break
                        if escooter: break
        
        booking.escooter = escooter or "Unknown eScooter"

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
        
        # Start background polling loop via thread
        t = threading.Thread(target=run_sync_loop, args=(engine, interval), daemon=True)
        t.start()
        
        # Start the Flask webhook listeners blocking the main thread
        port = int(os.getenv('PORT', '5001'))
        server = WebhookServer(engine, port=port)
        server.run(host='0.0.0.0')
        
    elif args.command == 'sync':
        engine.sync_upcoming()

