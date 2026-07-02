"""
Google Calendar API connector.
"""
from typing import List, Optional, Dict
import os
import time
from datetime import datetime, timezone, timedelta

try:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    GOOGLE_AVAILABLE = True
except ImportError:
    GOOGLE_AVAILABLE = False

from booking_model import Booking


class GoogleCalendarConnector:
    """Connector for Google Calendar API."""
    
    SCOPES = [
        'https://www.googleapis.com/auth/contacts', # Keep contacts for consistency
        'https://www.googleapis.com/auth/calendar'
    ]
    
    def __init__(self, credentials_file: str = 'credentials.json', token_file: str = 'token.json'):
        if not GOOGLE_AVAILABLE:
            raise ImportError("Google API libraries not installed. Run: pip install -r requirements.txt")
        
        def _parse_credentials_str(content: str):
            """Parse stringified Google Credentials object into valid JSON string."""
            import re
            import json
            val = content.strip()
            if not val.startswith('{'):
                return None
            try:
                json.loads(val)
                return val
            except Exception:
                pass
            
            # Match pattern of Credentials.__str__
            pattern = (
                r"\{token:\s*(?P<token>.*?),\s*"
                r"refresh_token:\s*(?P<refresh_token>.*?),\s*"
                r"token_uri:\s*(?P<token_uri>.*?),\s*"
                r"client_id:\s*(?P<client_id>.*?),\s*"
                r"client_secret:\s*(?P<client_secret>.*?),\s*"
                r"scopes:\s*\[(?P<scopes>.*?)\],\s*"
                r"universe_domain:\s*(?P<universe_domain>.*?),\s*"
                r"account:\s*(?P<account>.*?),\s*"
                r"expiry:\s*(?P<expiry>.*?)\}"
            )
            match = re.match(pattern, val)
            if match:
                data = match.groupdict()
                scopes = [s.strip() for s in data['scopes'].split(',') if s.strip()]
                json_data = {
                    "token": data['token'],
                    "refresh_token": data['refresh_token'],
                    "token_uri": data['token_uri'],
                    "client_id": data['client_id'],
                    "client_secret": data['client_secret'],
                    "scopes": scopes,
                    "universe_domain": data['universe_domain'],
                    "account": data['account'],
                    "expiry": data['expiry']
                }
                return json.dumps(json_data)
            return None

        # Self-healing: if credentials_file or token_file is a raw JSON string instead of a path
        parsed_credentials = _parse_credentials_str(credentials_file)
        if parsed_credentials:
            actual_credentials_path = 'env_files/credentials.json'
            try:
                os.makedirs(os.path.dirname(actual_credentials_path), exist_ok=True)
                with open(actual_credentials_path, 'w') as f:
                    f.write(parsed_credentials)
                credentials_file = actual_credentials_path
            except Exception as e:
                try:
                    with open('credentials.json', 'w') as f:
                        f.write(parsed_credentials)
                    credentials_file = 'credentials.json'
                except Exception:
                    pass

        parsed_token = _parse_credentials_str(token_file)
        if parsed_token:
            actual_token_path = 'env_files/token.json'
            try:
                os.makedirs(os.path.dirname(actual_token_path), exist_ok=True)
                with open(actual_token_path, 'w') as f:
                    f.write(parsed_token)
                token_file = actual_token_path
            except Exception as e:
                try:
                    with open('token.json', 'w') as f:
                        f.write(parsed_token)
                    token_file = 'token.json'
                except Exception:
                    pass

        # Validate file paths to prevent directory traversal
        if '..' in credentials_file or '..' in token_file:
            raise ValueError("Invalid file path: directory traversal not allowed")

        self.credentials_file = credentials_file
        self.token_file = token_file
        self.service = None
        import threading
        self._auth_lock = threading.Lock()
        
    def authenticate(self):
        """Authenticate with Google API."""
        with self._auth_lock:
            if self.service:
                return
            creds = None
            
            # 1. Check if token file exists and is not empty
            if os.path.exists(self.token_file):
                if os.path.getsize(self.token_file) == 0:
                    print(f"  ⚠️ Warning: Token file {self.token_file} is empty.")
                else:
                    try:
                        creds = Credentials.from_authorized_user_file(self.token_file, self.SCOPES)
                    except Exception as e:
                        print(f"  ⚠️ Error loading token from {self.token_file}: {e}")
            
            # 2. Refresh or validate
            if not creds or not creds.valid:
                # If we have an expired token with a refresh token, try refreshing it first
                if creds and creds.expired and creds.refresh_token:
                    try:
                        from google.auth.transport.requests import Request
                        creds.refresh(Request())
                    except Exception as e:
                        print(f"  ⚠️ Error refreshing token: {e}")
                        creds = None # Force error below
                
                if not creds or not creds.valid:
                    # Check credentials file integrity
                    if not os.path.exists(self.credentials_file) or os.path.getsize(self.credentials_file) == 0:
                        raise FileNotFoundError(
                            f"Google credentials file {self.credentials_file} is missing or empty. "
                            "Check your GitHub Secrets (GOOGLE_CREDENTIALS_JSON) and deployment logs."
                        )
                    
                    # In a headless server environment, we can't run flow.run_local_server.
                    # We must rely on the provided token.json.
                    raise ValueError(
                        f"Invalid or missing Google tokens in /app/env_files/{self.token_file}. "
                        "Ensure your GOOGLE_TOKEN_JSON secret is correctly populated in GitHub."
                    )
                
            import httplib2
            import google_auth_httplib2
            from googleapiclient.http import HttpRequest

            def build_request(http, *args, **kwargs):
                new_http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http())
                return HttpRequest(new_http, *args, **kwargs)

            self.service = build('calendar', 'v3', credentials=creds, requestBuilder=build_request)
        
    def fetch_events(self, calendar_id: str = 'primary', time_min: Optional[datetime] = None) -> List[dict]:
        """Fetch upcoming events from Google Calendar."""
        if not self.service:
            self.authenticate()
            
        if not time_min:
            time_min = datetime.now(timezone.utc)
            
        events = []
        page_token = None
        
        while True:
            result = self.service.events().list(
                calendarId=calendar_id,
                timeMin=time_min.isoformat(),
                singleEvents=True,
                orderBy='startTime',
                pageToken=page_token
            ).execute()
            
            events.extend(result.get('items', []))
            page_token = result.get('nextPageToken')
            if not page_token:
                break
                
        return events
        
    def upsert_booking_as_event(
        self,
        booking: Booking,
        calendar_id: str = 'primary',
        id_property_name: str = 'square_booking_id'
    ) -> str:
        """Create or update a calendar event from a booking."""
        if not self.service:
            self.authenticate()
            
        # Determine location for navigation
        location = booking.customer_address or booking.location
        
        # Build Itinerary
        itinerary = []
        for service in booking.services_list:
            itinerary.append(f"{service}")
        itinerary_str = "\n".join(itinerary) if itinerary else "None"
        
        # Build description
        description_parts = [
            "---- CONTACT INFO ----",
            f"{booking.customer_name or 'N/A'}",
            f"{booking.customer_phone or 'N/A'}"
        ]
        
        if booking.customer_email:
            description_parts.append(booking.customer_email)
            
        description_parts.extend([
            "",
            f"---- SERVICES (${booking.total_price:.2f}) ----",
            itinerary_str
        ])
        
        if booking.notes:
            description_parts.extend(["", booking.notes])
        
        event_body = {
            'summary': booking.summary,
            'location': location,
            'description': "\n".join(description_parts),
            'start': {
                'dateTime': booking.start_at.isoformat(),
                'timeZone': 'Australia/Melbourne',
            },
            'end': {
                'dateTime': booking.end_at.isoformat(),
                'timeZone': 'Australia/Melbourne',
            },
            'extendedProperties': {
                'private': {
                    id_property_name: booking.booking_id
                }
            }
        }
        
        if booking.google_event_id:
            try:
                # Update existing
                result = self.service.events().update(
                    calendarId=calendar_id,
                    eventId=booking.google_event_id,
                    body=event_body
                ).execute()
            except Exception as e:
                print(f"  ⚠️ Error updating event {booking.google_event_id} (may have been manually deleted): {e}. Falling back to insert.")
                # Fallback to insert
                result = self.service.events().insert(
                    calendarId=calendar_id,
                    body=event_body
                ).execute()
        else:
            # Create new
            result = self.service.events().insert(
                calendarId=calendar_id,
                body=event_body
            ).execute()

        new_event_id = result.get('id')

        # Remove any stale duplicate events that share the same booking ID but are
        # not the event we just created/updated (can happen if the time was changed
        # and the old event was left behind due to a failed lookup).
        try:
            all_ids = self.find_all_event_ids_by_private_property(
                id_property_name, booking.booking_id, calendar_id
            )
            for stale_id in all_ids:
                if stale_id != new_event_id:
                    print(f"  🧹 Removing stale duplicate event {stale_id} for {id_property_name}={booking.booking_id}")
                    try:
                        self.delete_event(stale_id, calendar_id)
                    except Exception as del_e:
                        print(f"  ⚠️ Could not remove stale event {stale_id}: {del_e}")
        except Exception as cleanup_e:
            print(f"  ⚠️ Duplicate cleanup check failed (non-fatal): {cleanup_e}")

        return new_event_id

    def delete_event(self, event_id: str, calendar_id: str = 'primary'):
        """Delete an event from Google Calendar."""
        if not self.service:
            self.authenticate()
        self.service.events().delete(calendarId=calendar_id, eventId=event_id).execute()

    def find_all_event_ids_by_private_property(
        self,
        property_name: str,
        property_value: str,
        calendar_id: str = 'primary'
    ) -> List[str]:
        """Return all event IDs whose private extended property matches the given key=value.

        Uses the Google Calendar API's server-side ``privateExtendedProperty`` filter
        rather than fetching every event and filtering in Python, which is both faster
        and more reliable.
        """
        if not self.service:
            self.authenticate()

        # Search 90 days back so we catch any recently-created quote/booking events
        # that may have a start time in the past, as well as all future events.
        time_min = datetime.now(timezone.utc) - timedelta(days=90)
        event_ids: List[str] = []
        page_token = None

        while True:
            result = self.service.events().list(
                calendarId=calendar_id,
                timeMin=time_min.isoformat(),
                privateExtendedProperty=f'{property_name}={property_value}',
                singleEvents=True,
                pageToken=page_token,
            ).execute()

            for event in result.get('items', []):
                eid = event.get('id')
                if eid:
                    event_ids.append(eid)

            page_token = result.get('nextPageToken')
            if not page_token:
                break

        return event_ids

    def find_event_id_by_private_property(
        self,
        property_name: str,
        property_value: str,
        calendar_id: str = 'primary'
    ) -> Optional[str]:
        """Find the first event ID whose private extended property matches the given key=value."""
        ids = self.find_all_event_ids_by_private_property(property_name, property_value, calendar_id)
        return ids[0] if ids else None
