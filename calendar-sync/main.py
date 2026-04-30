"""
Core sync engine for Square to Google Calendar.
"""
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Dict, Optional
from zoneinfo import ZoneInfo

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
        self.app.route('/ops-calendar-sync', methods=['POST'])(self.ops_calendar_sync)
        self.app.route('/webhooks/operations/calendar', methods=['POST'])(self.ops_calendar_sync)
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

    def _check_ops_api_key(self) -> bool:
        """Validate optional API key for operations calendar exchange."""
        expected = os.getenv('CALENDAR_SYNC_API_KEY', '').strip()
        if not expected:
            return True
        received = request.headers.get('X-API-Key', '').strip()
        return received == expected

    def _parse_ops_start_datetime(self, payload: dict) -> datetime:
        """Parse schedule fields from Operations payload using Melbourne timezone."""
        mel_tz = ZoneInfo("Australia/Melbourne")

        scheduled_at = payload.get('scheduled_at') or payload.get('scheduledAt')
        if scheduled_at:
            dt = datetime.fromisoformat(str(scheduled_at).replace('Z', '+00:00'))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=mel_tz)
            return dt.astimezone(mel_tz)

        scheduled_date = payload.get('scheduled_date') or payload.get('scheduledDate')
        scheduled_time = str(payload.get('scheduled_time') or payload.get('scheduledTime') or '09:00').strip()
        if not scheduled_date:
            raise ValueError("Missing scheduled_date (or scheduledDate) in payload")

        # Accept HH:MM or h:mm AM/PM
        try:
            if 'AM' in scheduled_time.upper() or 'PM' in scheduled_time.upper():
                parsed_time = datetime.strptime(scheduled_time.upper(), '%I:%M %p').strftime('%H:%M')
            else:
                parsed_time = datetime.strptime(scheduled_time, '%H:%M').strftime('%H:%M')
        except ValueError:
            parsed_time = '09:00'

        return datetime.fromisoformat(f"{scheduled_date}T{parsed_time}:00").replace(tzinfo=mel_tz)

    def _build_booking_from_ops_payload(self, payload: dict) -> Booking:
        """Map Operations job payload into canonical Booking model."""
        job_uid = payload.get('job_uid') or payload.get('jobUid') or payload.get('id')
        if not job_uid:
            raise ValueError("Missing job_uid (or jobUid/id) in payload")

        booking = Booking(str(job_uid))
        booking.status = payload.get('status')

        # Customer / contact
        booking.customer_name = payload.get('customer_name') or payload.get('customerName') or 'Customer'
        booking.customer_phone = payload.get('customer_phone') or payload.get('customerPhone') or payload.get('customer_number')
        booking.customer_email = payload.get('customer_email') or payload.get('customerEmail')
        booking.customer_suburb = payload.get('customer_suburb') or payload.get('customerSuburb') or payload.get('suburb')

        # Address + location
        booking.customer_address = payload.get('customer_address') or payload.get('customerAddress') or payload.get('address')
        booking.location = booking.customer_address or payload.get('location') or 'OnyaScoot'

        # Notes
        booking.notes = payload.get('notes') or payload.get('itinerary_note') or payload.get('itineraryNote') or ''

        # Services list can be string[] or object[]
        raw_services = payload.get('services') or payload.get('services_list') or payload.get('servicesList') or []
        booking.services_list = []
        computed_total = 0.0
        if isinstance(raw_services, list):
            for svc in raw_services:
                if isinstance(svc, str):
                    booking.services_list.append(svc)
                elif isinstance(svc, dict):
                    name = svc.get('description') or svc.get('name') or svc.get('service_name')
                    if name:
                        booking.services_list.append(str(name))
                    amount = svc.get('amount') or svc.get('price') or 0
                    try:
                        computed_total += float(amount)
                    except (TypeError, ValueError):
                        pass

        # Summary fields
        service_name = payload.get('service_name') or payload.get('serviceName')
        if service_name:
            booking.service_name = str(service_name)
        elif booking.services_list:
            booking.service_name = booking.services_list[0]
            if len(booking.services_list) > 1:
                booking.service_name += f" (+{len(booking.services_list)-1} more)"

        escooter = payload.get('escooter') or payload.get('eScooter')
        if not escooter:
            make = payload.get('scooter_make') or payload.get('scooterMake') or ''
            model = payload.get('scooter_model') or payload.get('scooterModel') or ''
            escooter = f"{make} {model}".strip()
        booking.escooter = escooter or "Unknown eScooter"

        total_price = payload.get('total_price')
        if total_price is None:
            total_price = payload.get('totalPrice')
        if total_price is None:
            total_price = payload.get('final_price')
        if total_price is None:
            total_price = computed_total
        try:
            booking.total_price = float(total_price or 0)
        except (TypeError, ValueError):
            booking.total_price = computed_total

        start_dt = self._parse_ops_start_datetime(payload)
        duration_minutes = payload.get('duration_minutes') or payload.get('durationMinutes') or 60
        try:
            duration_minutes = max(int(duration_minutes), 1)
        except (TypeError, ValueError):
            duration_minutes = 60

        booking.start_at = start_dt
        booking.end_at = start_dt + timedelta(minutes=duration_minutes)

        google_event_id = payload.get('google_event_id') or payload.get('googleEventId')
        if google_event_id:
            booking.google_event_id = str(google_event_id)

        return booking

    def ops_calendar_sync(self):
        """Operations portal -> calendar sync exchange endpoint."""
        if not self._check_ops_api_key():
            return jsonify({'error': 'unauthorized'}), 401

        payload = request.json or {}
        action = str(payload.get('action', 'upsert')).lower()
        job_uid = payload.get('job_uid') or payload.get('jobUid') or payload.get('id')

        if not job_uid:
            return jsonify({'error': 'bad_request', 'message': 'Missing job_uid (or jobUid/id)'}), 400

        try:
            if action == 'delete':
                event_id = payload.get('google_event_id') or payload.get('googleEventId')
                if not event_id:
                    event_id = self.engine.google.find_event_id_by_private_property('ops_job_uid', str(job_uid))

                if not event_id:
                    return jsonify({'status': 'not_found', 'job_uid': job_uid}), 404

                self.engine.google.delete_event(str(event_id))
                return jsonify({'status': 'deleted', 'job_uid': job_uid, 'google_event_id': event_id})

            booking = self._build_booking_from_ops_payload(payload)
            if not booking.google_event_id:
                booking.google_event_id = self.engine.google.find_event_id_by_private_property('ops_job_uid', booking.booking_id)

            event_id = self.engine.google.upsert_booking_as_event(booking, id_property_name='ops_job_uid')
            return jsonify({'status': 'ok', 'action': 'upsert', 'job_uid': job_uid, 'google_event_id': event_id})

        except Exception as e:
            print(f"[OPS-CALENDAR] Error: {e}")
            return jsonify({'error': 'sync_failed', 'message': str(e)}), 500

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
        self.square = None
        self.google = GoogleCalendarConnector(google_creds, google_token)

        enable_square = os.getenv('ENABLE_SQUARE', 'true').lower() in ('1', 'true', 'yes')
        if enable_square:
            self.square = SquareBookingConnector(square_token)
        
        # Cache for performance
        self.customer_cache = {}
        self.service_cache = {}
        
    def sync_upcoming(self):
        """Perform a full sync of upcoming bookings."""
        if not self.square:
            print("[SYNC] Square connector disabled. Skipping Square->Google sync loop.")
            return

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

            # 3. Process Square bookings and track active ones
            seen_square_ids = set()
            for booking in square_bookings:
                seen_square_ids.add(booking.booking_id)
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

            # 4. Clean up deleted/canceled bookings from Google Calendar
            for sq_id, google_event_id in existing_mapping.items():
                if sq_id not in seen_square_ids:
                    print(f"[DEBUG] Booking {sq_id} no longer accepted/upcoming in Square. Deleting Google event {google_event_id}")
                    try:
                        self.google.delete_event(google_event_id)
                    except Exception as del_e:
                        print(f"  --> Failed to delete {google_event_id}: {del_e}")

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
            booking.customer_email = cust_data.get('email_address')
            
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
                # We need to map keys like 'ctm_abcd' to their real names like 'eScooter 1'
                defs = self.square.get_custom_attribute_definitions()
                
                # We look for any attribute with "escooter" in the name or key
                for key, attr in attrs.items():
                    name = defs.get(key, '')
                    if 'escooter' in key.lower() or 'escooter' in name.lower():
                        val = attr.get('value') or attr.get('string_value')
                        if val:
                            escooter = str(val)
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

