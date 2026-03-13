"""
Contact data model with strict phone-based merge capabilities.
"""
from typing import Dict, List, Optional
from datetime import datetime, timezone
import json
import os
import re


def normalize_phone(phone: str) -> str:
    """
    Universally normalize an Australian phone number to 04...
    Strips all non-digit characters. Converts 614... to 04...
    """
    if not phone:
        return ""
    
    # Strip all non-digits
    digits = ''.join(filter(str.isdigit, str(phone)))
    
    if digits.startswith("614") and len(digits) == 11:
        return "0" + digits[2:]
        
    if digits.startswith("0614") and len(digits) == 12:
         return "0" + digits[3:]
         
    return digits


def parse_single_line_address(address_str: str) -> dict:
    """Parse single-line AU addresses into components."""
    if not address_str:
        return {}
        
    address_str = address_str.strip()
    states_re = r'\b(VIC|NSW|QLD|ACT|TAS|WA|SA|NT|VICTORIA|NEW SOUTH WALES|QUEENSLAND|TASMANIA|WESTERN AUSTRALIA|SOUTH AUSTRALIA|NORTHERN TERRITORY)\b'
    state_map = {
        'VICTORIA': 'VIC', 'NEW SOUTH WALES': 'NSW', 'QUEENSLAND': 'QLD',
        'TASMANIA': 'TAS', 'WESTERN AUSTRALIA': 'WA', 'SOUTH AUSTRALIA': 'SA', 'NORTHERN TERRITORY': 'NT'
    }
    
    result = {}
    
    # Try comma separated: Street, Suburb State Postcode
    match1 = re.search(r'^(.*?),[\s]*([A-Za-z\s]+)[\s,]+' + states_re + r'[\s,]*(\d{4})\s*$', address_str, re.IGNORECASE)
    if match1:
        result['street'] = match1.group(1).strip()
        result['city'] = match1.group(2).strip()
        state = match1.group(3).upper()
        result['state'] = state_map.get(state, state)
        result['postal_code'] = match1.group(4).strip()
        result['country'] = 'AU'
        return result
        
    # Try greedy street no comma: Street Suburb State Postcode 
    match2 = re.search(r'^(.*)[\s]+([A-Za-z]+)[\s,]+' + states_re + r'[\s,]*(\d{4})\s*$', address_str, re.IGNORECASE)
    if match2:
        result['street'] = match2.group(1).strip()
        result['city'] = match2.group(2).strip()
        state = match2.group(3).upper()
        result['state'] = state_map.get(state, state)
        result['postal_code'] = match2.group(4).strip()
        result['country'] = 'AU'
        return result
        
    # Try Street Suburb Postcode (no state)
    match3 = re.search(r'^(.*?)[\s,]+([A-Za-z\s]+?)[\s,]+(\d{4})\s*$', address_str, re.IGNORECASE)
    if match3:
        result['street'] = match3.group(1).strip().rstrip(',')
        result['city'] = match3.group(2).strip().rstrip(',')
        result['postal_code'] = match3.group(3).strip()
        result['country'] = 'AU'
        return result
        
    # Return as-is if no obvious format 
    return {}


def normalize_name(name: Optional[str]) -> str:
    """Normalize names for matching by stripping punctuation and lowercasing."""
    if not name:
        return ""
    # Strip dots, commas, extra spaces and lowercase
    clean = re.sub(r'[.,]', '', name).lower().strip()
    return clean


class Contact:
    """Represents a canonical contact synced between Square and Google."""
    
    def __init__(self, contact_id: str = None):
        self.contact_id = contact_id
        self.first_name: Optional[str] = None
        self.last_name: Optional[str] = None
        self.email: Optional[str] = None
        self.phone: Optional[str] = None
        self.company: Optional[str] = None
        self.notes: Optional[str] = None
        self.source_ids: Dict[str, str] = {}  # 'square' -> id, 'google' -> id
        self.last_modified: datetime = datetime.now(timezone.utc)
        self.addresses: List[Dict[str, str]] = []
        self.extra_fields: Dict[str, str] = {}
        self.custom_id: Optional[str] = None
        
    @property
    def normalized_phone(self) -> str:
        """Returns the universally normalized phone number for matching."""
        return normalize_phone(self.phone)

    def merge_with(self, other: 'Contact', source_of_truth: str = 'square', other_is_authoritative: bool = False) -> 'Contact':
        """
        Merge this contact with another.
        If other_is_authoritative is True, the incoming 'other' contact's fields ALWAYS win.
        Otherwise, we use source_of_truth and timestamp logic.
        """
        # 2. Determine supremacy based on source existence and timestamps
        other_is_truth = False
        self_is_truth = False
        other_wins = False
        
        if source_of_truth:
            if hasattr(other, 'source_ids') and other.source_ids:
                other_is_truth = (source_of_truth in other.source_ids)
            if hasattr(self, 'source_ids') and self.source_ids:
                self_is_truth = (source_of_truth in self.source_ids)

        # 1. Authoritative Override
        if other_is_authoritative:
            other_wins = True
        else:
            if other_is_truth and not self_is_truth:
                other_wins = True
            elif self_is_truth and not other_is_truth:
                other_wins = False
            elif self_is_truth and other_is_truth:
                # Both claim to have source data.
                # If the incoming one isn't authoritative (e.g. Google mirror) 
                # but we already have an authoritative version (e.g. Square), 
                # the existing Square data WINS regardless of timestamps.
                if not other_is_authoritative:
                    other_wins = False
                else:
                    # Both are truth and equally authoritative (e.g. two Square contacts), check timestamps.
                    self_mod = self.last_modified if self.last_modified.tzinfo else self.last_modified.replace(tzinfo=timezone.utc)
                    other_mod = other.last_modified if other.last_modified.tzinfo else other.last_modified.replace(tzinfo=timezone.utc)
                    other_wins = (other_mod > self_mod)
            else:
                # Neither is truth, use timestamp
                self_mod = self.last_modified if self.last_modified.tzinfo else self.last_modified.replace(tzinfo=timezone.utc)
                other_mod = other.last_modified if other.last_modified.tzinfo else other.last_modified.replace(tzinfo=timezone.utc)
                other_wins = (other_mod > self_mod)

        if other_wins:
            if source_of_truth and other_is_truth:
                # Source of truth's values are ABSOLUTE. Even None means "explicitly cleared".
                self.first_name = other.first_name
                self.last_name = other.last_name
                self.email = other.email
                self.phone = other.phone
                self.company = other.company
                self.notes = other.notes
                self.addresses = other.addresses if other.addresses else self.addresses
                
                # Clobber extra_fields: keys missing in other are explicitly cleared
                for k in list(self.extra_fields.keys()):
                    if k not in other.extra_fields:
                        self.extra_fields[k] = ''
                for k, v in other.extra_fields.items():
                    self.extra_fields[k] = v
            else:
                # Non-authoritative merge: only overwrite if other has a value
                self.first_name = other.first_name if other.first_name is not None else self.first_name
                self.last_name = other.last_name if other.last_name is not None else self.last_name
                self.email = other.email if other.email is not None else self.email
                self.phone = other.phone if other.phone is not None else self.phone
                self.company = other.company if other.company is not None else self.company
                self.notes = other.notes if other.notes is not None else self.notes
                self.addresses = other.addresses if other.addresses else self.addresses
                
                for k, v in other.extra_fields.items():
                    self.extra_fields[k] = v
        else:
            if source_of_truth and self_is_truth:
                # Self IS the source of truth. Keep ALL of self's values unconditionally.
                # Even if self.email is None, that means Square says "no email" — don't
                # let Google's stale data overwrite it.
                # self.fields are already correct; only merge addresses if self has none
                self.addresses = self.addresses or other.addresses
                
                # extra_fields: keys in other but missing in self are explicitly cleared
                for k in list(other.extra_fields.keys()):
                    if k not in self.extra_fields:
                        self.extra_fields[k] = ''
            else:
                # Non-authoritative merge: only overwrite if self has a value
                self.first_name = self.first_name if self.first_name is not None else other.first_name
                self.last_name = self.last_name if self.last_name is not None else other.last_name
                self.email = self.email if self.email is not None else other.email
                self.phone = self.phone if self.phone is not None else other.phone
                self.company = self.company if self.company is not None else other.company
                self.notes = self.notes if self.notes is not None else other.notes
                self.addresses = self.addresses or other.addresses
                
                for k, v in other.extra_fields.items():
                    if k not in self.extra_fields or not self.extra_fields[k]:
                        self.extra_fields[k] = v

        self.custom_id = self.custom_id or other.custom_id

        # Source IDs are ALWAYS combined additively
        if hasattr(other, 'source_ids') and other.source_ids:
            if not hasattr(self, 'source_ids') or self.source_ids is None:
                self.source_ids = {}
            self.source_ids.update(other.source_ids)
        
        # Ensure only 1 address maximum and parse single lines
        if len(self.addresses) > 1:
            self.addresses = [self.addresses[0]]
            
        self.normalize_addresses()
            
        return self

    def normalize_addresses(self):
        """Refactor single line addresses into explicit components."""
        for addr in self.addresses:
            street = addr.get('street', '').strip()
            city = addr.get('city', '').strip()
            postcode = addr.get('postal_code', '').strip()
            
            # If we only have a street and no city/postcode, it's likely a single-line address
            if street and not city and not postcode:
                parsed = parse_single_line_address(street)
                if parsed:
                    # Update with structured components
                    addr.update(parsed)

    def to_dict(self) -> Dict:
        return {
            'contact_id': self.contact_id,
            'custom_id': getattr(self, 'custom_id', None),
            'first_name': self.first_name,
            'last_name': self.last_name,
            'email': self.email,
            'phone': self.phone,
            'company': self.company,
            'notes': self.notes,
            'source_ids': self.source_ids,
            'last_modified': self.last_modified.isoformat(),
            'addresses': self.addresses,
            'extra_fields': self.extra_fields
        }

    @staticmethod
    def from_dict(data: Dict) -> 'Contact':
        contact = Contact(data.get('contact_id'))
        contact.custom_id = data.get('custom_id')
        contact.first_name = data.get('first_name')
        contact.last_name = data.get('last_name')
        contact.email = data.get('email')
        contact.phone = data.get('phone')
        contact.company = data.get('company')
        contact.notes = data.get('notes')
        contact.source_ids = data.get('source_ids', {})
        contact.addresses = data.get('addresses', [])
        contact.extra_fields = data.get('extra_fields', {})
        
        if 'last_modified' in data:
            dt = datetime.fromisoformat(data['last_modified'])
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            contact.last_modified = dt
            
        contact.normalize_addresses()
        return contact

    def __repr__(self):
        return f"Contact({self.first_name} {self.last_name}, {self.phone})"


class ContactStore:
    """In-memory canonical storage, matching on IDs, email, or phone numbers."""
    
    def __init__(self):
        self.contacts: Dict[str, Contact] = {}
        self.phone_index: Dict[str, str] = {}    # normalized phone -> contact_id
        self.email_index: Dict[str, str] = {}    # email -> contact_id
        self.square_id_index: Dict[str, str] = {} # square_id -> contact_id
        self.custom_id_index: Dict[str, str] = {} # custom_id -> contact_id
        self.name_index: Dict[str, str] = {}     # normalized name -> contact_id
        
    def add_contact(self, contact: Contact, source_of_truth: str = 'square', authoritative: bool = False) -> str:
        """Add or merge a contact by checking multiple identifiers."""
        # Enforce defaults for AU
        for addr in contact.addresses:
            if not addr.get('state'):
                addr['state'] = 'Victoria'
            if not addr.get('country'):
                addr['country'] = 'AU'

        existing_id = self._find_existing_contact(contact)
            
        if existing_id:
            # Merge into the existing contact
            self.contacts[existing_id].merge_with(contact, source_of_truth=source_of_truth, other_is_authoritative=authoritative)
            self._update_indexes(self.contacts[existing_id])
            return existing_id
            
        # New Contact, generate ID
        if not contact.contact_id:
            contact.contact_id = f"contact_{len(self.contacts) + 1}"
            
        self.contacts[contact.contact_id] = contact
        self._update_indexes(contact)
        return contact.contact_id

    def _find_existing_contact(self, contact: Contact) -> Optional[str]:
        """Check all indexes to find a matching contact."""
        # 1. Match by Square ID (Strongest link)
        sq_id = contact.source_ids.get('square')
        if sq_id and sq_id in self.square_id_index:
            return self.square_id_index[sq_id]
            
        # 2. Match by Custom ID (cst-...)
        if contact.custom_id and contact.custom_id in self.custom_id_index:
            return self.custom_id_index[contact.custom_id]
            
        # 3. Match by Normalized Phone
        clean_phone = contact.normalized_phone
        if clean_phone and clean_phone in self.phone_index:
            return self.phone_index[clean_phone]
            
        # 4. Match by Email
        if contact.email:
            email_lower = contact.email.lower().strip()
            if email_lower in self.email_index:
                return self.email_index[email_lower]
                
        # 5. Match by Name (Fallback for contacts like "Georgia .")
        name_key = self._get_name_key(contact)
        if name_key and name_key in self.name_index:
             # ONLY match by name if we don't have better identifiers on the incoming contact
             if not contact.normalized_phone and not contact.email:
                 return self.name_index[name_key]
                 
        return None

    def _get_name_key(self, contact: Contact) -> str:
        """Construct a lookup key from contact names."""
        first = normalize_name(contact.first_name)
        last = normalize_name(contact.last_name)
        if first and last:
            return f"{first}|{last}"
        return first or last

    def _update_indexes(self, contact: Contact):
        """Update lookup indexes for the contact."""
        cid = contact.contact_id
        
        # Phone
        clean_phone = contact.normalized_phone
        if clean_phone:
            self.phone_index[clean_phone] = cid
            
        # Email
        if contact.email:
            self.email_index[contact.email.lower().strip()] = cid
            
        # Square ID
        sq_id = contact.source_ids.get('square')
        if sq_id:
            self.square_id_index[sq_id] = cid
            
        # Custom ID
        if contact.custom_id:
            self.custom_id_index[contact.custom_id] = cid
            
        # Name Fallback
        name_key = self._get_name_key(contact)
        if name_key:
            self.name_index[name_key] = cid

    def get_all_contacts(self) -> List[Contact]:
        return list(self.contacts.values())
        
    def get_contact_by_phone(self, phone: str) -> Optional[Contact]:
        clean = normalize_phone(phone)
        if clean and clean in self.phone_index:
            return self.contacts[self.phone_index[clean]]
        return None

    def clear(self):
        self.contacts.clear()
        self.phone_index.clear()
        self.email_index.clear()
        self.square_id_index.clear()
        self.custom_id_index.clear()
        self.name_index.clear()
