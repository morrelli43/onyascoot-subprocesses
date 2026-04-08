"""
Google Contacts API connector.
"""
from typing import List, Optional
import os
import ssl
import time
from datetime import datetime

try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    GOOGLE_AVAILABLE = True
except ImportError:
    GOOGLE_AVAILABLE = False

from contact_model import Contact


class GoogleContactsConnector:
    """Connector for Google Contacts API."""
    
    SCOPES = ['https://www.googleapis.com/auth/contacts']
    
    def __init__(self, credentials_file: str = 'credentials.json', token_file: str = 'token.json'):
        if not GOOGLE_AVAILABLE:
            raise ImportError("Google API libraries not installed. Run: pip install -r requirements.txt")
        
        # Validate file paths to prevent directory traversal
        if '..' in credentials_file or '..' in token_file:
            raise ValueError("Invalid file path: directory traversal not allowed")
        
        self.credentials_file = credentials_file
        self.token_file = token_file
        self.service = None
    
    def authenticate(self):
        """Authenticate with Google API."""
        creds = None
        
        # Load existing token
        if os.path.exists(self.token_file):
            if os.path.getsize(self.token_file) == 0:
                print(f"  ⚠️ Warning: Token file {self.token_file} is empty.")
                # Force re-authentication or re-generation
            else:
                try:
                    creds = Credentials.from_authorized_user_file(self.token_file, self.SCOPES)
                except Exception as e:
                    print(f"  ⚠️ Error loading token from {self.token_file}: {e}")
        
        # Refresh or get new credentials
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                try:
                    creds.refresh(Request())
                except Exception as e:
                    print(f"  ⚠️ Error refreshing token: {e}")
                    creds = None # Force re-auth
            
            if not creds:
                if not os.path.exists(self.credentials_file) or os.path.getsize(self.credentials_file) == 0:
                    raise FileNotFoundError(
                        f"Credentials file {self.credentials_file} is missing or empty. "
                        "Check your GitHub Secrets and deployment logs."
                    )
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.credentials_file, self.SCOPES)
                creds = flow.run_local_server(port=0)
            
            # Save credentials
            with open(self.token_file, 'w') as token:
                token.write(creds.to_json())
        
        self.service = build('people', 'v1', credentials=creds)
    
    def fetch_contacts(self) -> List[Contact]:
        """Fetch all contacts from Google."""
        if not self.service:
            self.authenticate()
        
        contacts = []
        page_token = None
        
        while True:
            results = self.service.people().connections().list(
                resourceName='people/me',
                pageSize=1000,
                personFields='names,emailAddresses,phoneNumbers,organizations,addresses,biographies,userDefined',
                pageToken=page_token
            ).execute()
            
            connections = results.get('connections', [])
            
            for person in connections:
                contact = self._convert_to_contact(person)
                if contact:
                    contacts.append(contact)
            
            page_token = results.get('nextPageToken')
            if not page_token:
                break
        
        return contacts
    
    def _convert_to_contact(self, person: dict) -> Optional[Contact]:
        """Convert Google person object to Contact."""
        contact = Contact()
        
        # Extract name
        names = person.get('names', [])
        if names:
            contact.first_name = names[0].get('givenName')
            contact.last_name = names[0].get('familyName')
        
        # Extract email
        emails = person.get('emailAddresses', [])
        if emails:
            contact.email = emails[0].get('value')
        
        # Extract phone
        phones = person.get('phoneNumbers', [])
        if phones:
            contact.phone = phones[0].get('value')
        
        # Extract company and Job Title (escooter1)
        orgs = person.get('organizations', [])
        if orgs:
            contact.company = orgs[0].get('name')
            title = orgs[0].get('title')
            if title:
                contact.extra_fields['escooter1'] = title
        
        # Extract addresses
        addresses = person.get('addresses', [])
        for addr in addresses:
            street_full = addr.get('streetAddress', '')
            # Handle both newline (old) and comma (new) separators
            if '\n' in street_full:
                street_parts = street_full.split('\n', 1)
                street = street_parts[0]
                street2 = street_parts[1] if len(street_parts) > 1 else ''
            elif ', ' in street_full:
                # Common AU format: "Unit X, Street Y" - we want to keep them separated
                street_parts = street_full.split(', ', 1)
                # If there's a comma, the unit/apt is usually the first part
                # but our internal model expects street1, street2. 
                # Let's be smart: if the first part is short (like "Unit 1" or "Apt 2"), it's street2.
                if len(street_parts[0]) < 15 and any(word in street_parts[0].lower() for word in ['unit', 'apt', 'flat', 'level']):
                    street = street_parts[1]
                    street2 = street_parts[0]
                else:
                    street = street_parts[0]
                    street2 = street_parts[1] if len(street_parts) > 1 else ''
            else:
                street = street_full
                street2 = ''
            
            # Use only the first primary address
            contact.addresses = [{
                'street': street,
                'street2': street2,
                'city': addr.get('city', ''),
                'state': addr.get('region', ''),
                'postal_code': addr.get('postalCode', ''),
                'country': addr.get('country', '')
            }]
            break  # Only process the first address
        
        # Extract notes
        bios = person.get('biographies', [])
        if bios:
            contact.notes = bios[0].get('value')
        
        # Extract user defined fields (custom fields)
        user_defined = person.get('userDefined', [])
        for field in user_defined:
            key = field.get('key')
            value = field.get('value')
            if key and value:
                if key in ['escooter1', 'escooter2', 'escooter3']:
                    contact.extra_fields[key] = value
                elif key == 'square_id':
                    contact.source_ids['square'] = value
                elif key == 'custom_id' or key == 'customer_uid':
                    contact.custom_id = value
        
        # Extract last modified time from metadata
        metadata = person.get('metadata', {})
        sources = metadata.get('sources', [])
        if sources:
            update_time = sources[0].get('updateTime')
            if update_time:
                # Google format: "2023-11-01T12:00:00.000Z"
                dt = datetime.fromisoformat(update_time.replace('Z', '+00:00'))
                contact.last_modified = dt

        # Store Google resource name
        resource_name = person.get('resourceName')
        if resource_name:
            contact.source_ids['google'] = resource_name
        
        return contact if (
            contact.email or 
            contact.normalized_phone or 
            contact.first_name or 
            contact.last_name
        ) else None
    
    # Transient errors that should trigger a retry
    _RETRYABLE_EXCEPTIONS = (
        ssl.SSLError,
        ConnectionError,
        ConnectionResetError,
        TimeoutError,
        OSError,
    )

    def _is_retryable(self, exc: Exception) -> bool:
        """Check if an exception is a transient error worth retrying."""
        # Direct match on known transient exception types
        if isinstance(exc, self._RETRYABLE_EXCEPTIONS):
            return True
        # Google API HTTP errors — retry on 429, 500, 502, 503, 504
        try:
            from googleapiclient.errors import HttpError
            if isinstance(exc, HttpError) and exc.resp.status in (429, 500, 502, 503, 504):
                return True
        except ImportError:
            pass
        # Catch urllib3 / httplib wrapped errors by message
        err_msg = str(exc).lower()
        if any(keyword in err_msg for keyword in [
            'ssl', 'timed out', 'timeout', 'connection reset',
            'request-sent', 'record layer failure', 'broken pipe'
        ]):
            return True
        return False

    def _retry_api_call(self, func, *args, max_retries: int = 3, **kwargs):
        """
        Execute a Google API call with retry + exponential backoff.

        Retries on transient SSL, timeout, and connection errors.
        """
        last_exc = None
        for attempt in range(max_retries + 1):
            try:
                result = func(*args, **kwargs)
                # Small delay between successful API calls to avoid bursts
                time.sleep(0.3)
                return result
            except Exception as exc:
                last_exc = exc
                if attempt < max_retries and self._is_retryable(exc):
                    delay = (2 ** attempt)  # 1s, 2s, 4s
                    print(f"  Transient error (attempt {attempt + 1}/{max_retries + 1}): {exc}")
                    print(f"  Retrying in {delay}s...")
                    time.sleep(delay)
                else:
                    raise
        raise last_exc  # Should not reach here, but just in case

    def push_contact(self, contact: Contact) -> bool:
        """Push a contact to Google Contacts (with retry on transient errors)."""
        if not self.service:
            self.authenticate()
        
        try:
            # Check if contact already exists in Google
            if 'google' in contact.source_ids:
                # Update existing contact
                self._update_contact(contact)
            else:
                # Create new contact
                self._create_contact(contact)
            return True
        except Exception as e:
            print(f"Error pushing contact to Google: {e}")
            return False
            
    def delete_contact(self, resource_name: str) -> bool:
        """Delete a contact from Google Contacts."""
        if not self.service:
            self.authenticate()
            
        try:
            self.service.people().deleteContact(
                resourceName=resource_name
            ).execute()
            print(f"Deleted contact {resource_name} from Google.")
            return True
        except Exception as e:
            print(f"Error deleting contact from Google: {e}")
            return False
    
    def _create_contact(self, contact: Contact):
        """Create a new contact in Google (with retry)."""
        person = self._contact_to_person(contact)
        
        result = self._retry_api_call(
            self.service.people().createContact(
                body=person
            ).execute
        )
        
        # Store the new resource name
        contact.source_ids['google'] = result.get('resourceName')
    
    def _update_contact(self, contact: Contact):
        """Update an existing contact in Google (with retry)."""
        resource_name = contact.source_ids['google']
        person = self._contact_to_person(contact)
        
        # Get current contact to retrieve etag (with retry)
        current = self._retry_api_call(
            self.service.people().get(
                resourceName=resource_name,
                personFields='names'
            ).execute
        )
        
        person['etag'] = current.get('etag')
        
        self._retry_api_call(
            self.service.people().updateContact(
                resourceName=resource_name,
                updatePersonFields='names,emailAddresses,phoneNumbers,organizations,addresses,biographies,userDefined',
                body=person
            ).execute
        )
    
    def _contact_to_person(self, contact: Contact) -> dict:
        """Convert Contact to Google person object."""
        person = {}
        
        # Name
        if contact.first_name or contact.last_name:
            name_entry = {}
            if contact.first_name:
                name_entry['givenName'] = contact.first_name
            if contact.last_name:
                name_entry['familyName'] = contact.last_name
            person['names'] = [name_entry]
        else:
            person['names'] = []
        
        # Email
        if contact.email:
            person['emailAddresses'] = [{'value': contact.email}]
        else:
            person['emailAddresses'] = []
            
        # Phone
        if contact.phone:
            person['phoneNumbers'] = [{'value': contact.phone}]
        else:
            person['phoneNumbers'] = []
        
        # Company and Job Title (eScooter 1)
        company_val = contact.company
        title_val = contact.extra_fields.get('escooter1')
        
        if company_val or title_val:
            org_entry = {}
            if company_val:
                org_entry['name'] = company_val
            if title_val:
                org_entry['title'] = title_val
                
            person['organizations'] = [org_entry]
        else:
            person['organizations'] = []
        
        # Addresses
        if contact.addresses:
            addr = contact.addresses[0]
            street1 = addr.get('street', '')
            street2 = addr.get('street2', '')
            if street2:
                full_street = f"{street2}, {street1}"
            else:
                full_street = street1
            
            addr_entry = {}
            if full_street:
                addr_entry['streetAddress'] = full_street
            if addr.get('city'):
                addr_entry['city'] = addr.get('city')
            if addr.get('state'):
                addr_entry['region'] = addr.get('state')
            if addr.get('postal_code'):
                addr_entry['postalCode'] = addr.get('postal_code')
            if addr.get('country'):
                addr_entry['country'] = addr.get('country')
                
            person['addresses'] = [addr_entry] if addr_entry else []
        else:
            person['addresses'] = []
        
        # Notes
        if contact.notes:
            person['biographies'] = [{'value': contact.notes}]
        else:
            person['biographies'] = []
            
        # User Defined Fields (Custom Fields)
        person['userDefined'] = []
        for key in ['escooter1', 'escooter2', 'escooter3']:
            val = contact.extra_fields.get(key, '')
            # Google API rejects value: "" with a 400 Invalid Argument. 
            # To delete a custom field, simply omitting it from the appended array entirely is required.
            if val:
                person['userDefined'].append({
                    'key': key,
                    'value': val
                })
                
        # Also store the Square Customer ID in Google Contacts custom fields natively
        square_id = contact.source_ids.get('square', '')
        if square_id:
            person['userDefined'].append({
                'key': 'square_id',
                'value': square_id
            })
            
        # Also store the overarching Custom ID (cst-XXXXXXXXX) as customer_uid
        custom_id = getattr(contact, 'custom_id', None)
        if custom_id:
            person['userDefined'].append({
                'key': 'customer_uid',
                'value': custom_id
            })
        
        return person
