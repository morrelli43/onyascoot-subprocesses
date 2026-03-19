"""
Square Bookings API connector.
"""
from typing import List, Optional
import os
from datetime import datetime, timezone

try:
    from square.client import Client
    SQUARE_AVAILABLE = True
except ImportError:
    SQUARE_AVAILABLE = False

from booking_model import Booking


class SquareBookingConnector:
    """Connector for Square Bookings API."""
    
    def __init__(self, access_token: str = None):
        if not SQUARE_AVAILABLE:
            raise ImportError("Square API library not installed. Run: pip install squareup")
        
        self.access_token = access_token or os.getenv('SQUARE_ACCESS_TOKEN')
        if not self.access_token:
            raise ValueError("Square access token not provided. Set SQUARE_ACCESS_TOKEN environment variable.")
        
        self.client = Client(
            access_token=self.access_token,
            environment='production'
        )
        
    def fetch_upcoming_bookings(self, limit: int = 100) -> List[Booking]:
        """Fetch upcoming bookings from Square."""
        bookings = []
        
        try:
            # We want bookings that are upcoming
            # v30 SDK might not have search_bookings or it might be restricted, using list_bookings
            start_at_min = datetime.now(timezone.utc).isoformat()
            
            result = self.client.bookings.list_bookings(
                start_at_min=start_at_min,
                limit=limit
            )
            
            if result.is_success():
                all_upcoming = result.body.get('bookings', [])
                # Filter for ACCEPTED status in code since list_bookings filter is limited in some SDK versions
                square_bookings = [b for b in all_upcoming if b.get('status') == 'ACCEPTED']
                
                print(f"Found {len(all_upcoming)} total upcoming bookings, {len(square_bookings)} are accepted.")
                
                for sb in square_bookings:
                    booking = self._convert_to_booking(sb)
                    if booking:
                        bookings.append(booking)
            else:
                print(f"Error listing Square bookings: {result.errors}")
                
        except Exception as e:
            print(f"Error connecting to Square API (Bookings): {e}")
            
        return bookings
    
    def _convert_to_booking(self, sb: dict) -> Optional[Booking]:
        """Convert Square booking object to Booking model."""
        booking = Booking(sb.get('id'))
        
        # Timing
        start_at = sb.get('start_at')
        if start_at:
            booking.start_at = datetime.fromisoformat(start_at.replace('Z', '+00:00'))
            
        # Segments and Services
        segments = sb.get('appointment_segments', [])
        booking.service_ids = [s.get('service_variation_id') for s in segments if s.get('service_variation_id')]
        
        if segments:
            total_duration = sum(s.get('duration_minutes', 0) for s in segments)
            if booking.start_at:
                from datetime import timedelta
                booking.end_at = booking.start_at + timedelta(minutes=total_duration)
            
            # Primary service ID for legacy support/summary
            booking.service_id = booking.service_ids[0] if booking.service_ids else None
        
        # Customer
        booking.customer_id = sb.get('customer_id')
        # We need to fetch the customer name for the summary.
        # Enrichment will happen in a separate step or here via cache.
        
        booking.status = sb.get('status')
        booking.notes = sb.get('customer_note', '')
        
        # Location
        location_id = sb.get('location_id')
        # Could enrich location name too.
            
        return booking

    def get_customer_details(self, customer_id: str) -> dict:
        """Fetch customer details from Square."""
        try:
            result = self.client.customers.retrieve_customer(customer_id=customer_id)
            if result.is_success():
                return result.body.get('customer', {})
        except Exception as e:
            print(f"Error fetching customer {customer_id}: {e}")
        return {}
        
    def get_customer_custom_attributes(self, customer_id: str) -> dict:
        """Fetch custom attributes for a customer."""
        try:
            # Note: This might require specific SDK support or a separate API call.
            # In Square SDK v2 (around 30.x), this is usually under customer_custom_attributes.
            if hasattr(self.client, 'customer_custom_attributes'):
                result = self.client.customer_custom_attributes.list_customer_custom_attributes(
                    customer_id=customer_id,
                    with_definitions=True
                )
                if result.is_success():
                    # Return mapped attributes
                    return {attr.get('key'): attr for attr in result.body.get('custom_attributes', [])}
            elif hasattr(self.client.customers, 'list_customer_custom_attributes'):
                # Some SDK versions have it here
                result = self.client.customers.list_customer_custom_attributes(customer_id=customer_id)
                if result.is_success():
                    return {attr.get('key'): attr for attr in result.body.get('custom_attributes', [])}
        except Exception as e:
            print(f"  ⚠️ Warning: Could not fetch custom attributes for customer {customer_id}: {e}")
        return {}
        
    def get_service_details(self, service_variation_id: str) -> dict:
        """Fetch service details from Catalog."""
        try:
            result = self.client.catalog.retrieve_catalog_object(object_id=service_variation_id)
            if result.is_success():
                obj = result.body.get('object', {})
                # It's a item_variation, we want the item name probably.
                return obj
        except Exception as e:
            print(f"Error fetching service {service_variation_id}: {e}")
        return {}
