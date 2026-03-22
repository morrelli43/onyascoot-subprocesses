"""
Booking data model for Square to Google Calendar sync.
"""
from typing import Dict, List, Optional
from datetime import datetime, timezone
import json

class Booking:
    """Represents a canonical booking synced between Square and Google Calendar."""
    
    def __init__(self, booking_id: str = None):
        self.booking_id = booking_id # Square Booking ID
        self.customer_id: Optional[str] = None
        self.customer_name: Optional[str] = "Customer"
        self.customer_email: Optional[str] = None
        self.customer_phone: Optional[str] = None
        self.customer_address: Optional[str] = None
        self.customer_suburb: Optional[str] = None
        
        self.service_id: Optional[str] = None
        self.service_name: Optional[str] = "Service"
        self.service_ids: List[str] = []
        self.services_list: List[str] = []
        self.total_price: float = 0.0
        self.escooter: Optional[str] = None
        
        self.start_at: Optional[datetime] = None
        self.end_at: Optional[datetime] = None
        self.status: Optional[str] = None
        self.notes: Optional[str] = ""
        
        self.google_event_id: Optional[str] = None
        self.location: Optional[str] = "OnyaScoot"
        
    @property
    def summary(self) -> str:
        """Name | Suburb | eScooter - Service"""
        parts = []
        if self.customer_name: parts.append(self.customer_name)
        if self.customer_suburb: parts.append(self.customer_suburb)
        
        # Filter "Commuter eScooter" from service name
        service_display = self.service_name.replace("Commuter eScooter", "").strip(" -")
        
        # Use escooter model if available, otherwise default to "eScooter"
        escooter_display = self.escooter if self.escooter and self.escooter.lower() != "unknown escooter" else "eScooter"
        
        detail = f"{escooter_display} - {service_display}"
        parts.append(detail)
        
        return " | ".join(parts)

    def to_dict(self) -> Dict:
        return {
            'booking_id': self.booking_id,
            'customer_id': self.customer_id,
            'customer_name': self.customer_name,
            'customer_email': self.customer_email,
            'customer_phone': self.customer_phone,
            'service_id': self.service_id,
            'service_name': self.service_name,
            'start_at': self.start_at.isoformat() if self.start_at else None,
            'end_at': self.end_at.isoformat() if self.end_at else None,
            'status': self.status,
            'notes': self.notes,
            'google_event_id': self.google_event_id,
            'location': self.location,
            'customer_address': self.customer_address,
            'total_price': self.total_price,
            'escooter': self.escooter,
            'services_list': self.services_list,
            'service_ids': self.service_ids,
            'customer_suburb': self.customer_suburb
        }

    @staticmethod
    def from_dict(data: Dict) -> 'Booking':
        booking = Booking(data.get('booking_id'))
        booking.customer_id = data.get('customer_id')
        booking.customer_name = data.get('customer_name')
        booking.customer_email = data.get('customer_email')
        booking.customer_phone = data.get('customer_phone')
        booking.service_id = data.get('service_id')
        booking.service_name = data.get('service_name')
        booking.status = data.get('status')
        booking.notes = data.get('notes')
        booking.google_event_id = data.get('google_event_id')
        booking.location = data.get('location')
        booking.customer_address = data.get('customer_address')
        booking.total_price = data.get('total_price', 0.0)
        booking.escooter = data.get('escooter')
        booking.services_list = data.get('services_list', [])
        booking.service_ids = data.get('service_ids', [])
        booking.customer_suburb = data.get('customer_suburb')
        
        if data.get('start_at'):
            booking.start_at = datetime.fromisoformat(data['start_at'])
        if data.get('end_at'):
            booking.end_at = datetime.fromisoformat(data['end_at'])
            
        return booking

    def __repr__(self):
        return f"Booking({self.summary}, {self.start_at})"
