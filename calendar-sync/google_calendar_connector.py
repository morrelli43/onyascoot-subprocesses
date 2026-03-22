"""
Google Calendar API connector.
"""
from typing import List, Optional, Dict
import os
import time
from datetime import datetime, timezone

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
        
        self.credentials_file = credentials_file
        self.token_file = token_file
        self.service = None
        
    def authenticate(self):
        """Authenticate with Google API."""
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
            
        self.service = build('calendar', 'v3', credentials=creds)
        
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
        
    def upsert_booking_as_event(self, booking: Booking, calendar_id: str = 'primary') -> str:
        """Create or update a calendar event from a booking."""
        if not self.service:
            self.authenticate()
            
        # Determine location for navigation
        location = booking.customer_address or booking.location
        
        # Filter "Commuter eScooter" from services list
        filtered_services = [s.replace("Commuter eScooter", "").strip(" -") for s in booking.services_list]
        primary_service = booking.service_name.replace("Commuter eScooter", "").strip(" -")
        
        # Build Job Summary description
        description_parts = [
            "--- JOB SUMMARY ---",
            f"Price: ${booking.total_price:.2f}",
            f"eScooter: {booking.escooter or 'N/A'}",
            f"Services: {', '.join(filtered_services) or primary_service}",
            "\n--- CONTACT INFO ---",
            f"Customer: {booking.customer_name}",
            f"Phone: {booking.customer_phone or 'N/A'}",
            f"Address: {booking.customer_address or 'N/A'}",
            f"\nNotes: {booking.notes}" if booking.notes else ""
        ]
        
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
                    'square_booking_id': booking.booking_id
                }
            }
        }
        
        if booking.google_event_id:
            # Update existing
            result = self.service.events().update(
                calendarId=calendar_id,
                eventId=booking.google_event_id,
                body=event_body
            ).execute()
        else:
            # Create new
            result = self.service.events().insert(
                calendarId=calendar_id,
                body=event_body
            ).execute()
            
        return result.get('id')

    def delete_event(self, event_id: str, calendar_id: str = 'primary'):
        """Delete an event from Google Calendar."""
        if not self.service:
            self.authenticate()
        self.service.events().delete(calendarId=calendar_id, eventId=event_id).execute()
