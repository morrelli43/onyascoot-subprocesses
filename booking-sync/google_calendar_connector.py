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
        if os.path.exists(self.token_file):
            creds = Credentials.from_authorized_user_file(self.token_file, self.SCOPES)
        
        if not creds or not creds.valid:
            # If we don't have valid credentials, we can't do much in a headless environment.
            # We assume the user has run the token update script.
            raise ValueError(f"Invalid or missing Google tokens in {self.token_file}. Run update_google_token.py first.")
            
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
        
        # Build Job Summary description
        description_parts = [
            "--- JOB SUMMARY ---",
            f"Price: ${booking.total_price:.2f}",
            f"eScooter: {booking.escooter or 'N/A'}",
            f"Services: {', '.join(booking.services_list) or booking.service_name}",
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
