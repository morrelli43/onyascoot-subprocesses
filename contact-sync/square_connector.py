"""
Square Up API connector.
"""
from typing import List, Optional
import os
from datetime import datetime, timezone

try:
    from square.client import Client
    SQUARE_AVAILABLE = True
except ImportError:
    SQUARE_AVAILABLE = False

from contact_model import Contact


class SquareConnector:
    """Connector for Square Up API."""
    
    def __init__(self, access_token: str = None):
        if not SQUARE_AVAILABLE:
            raise ImportError("Square API library not installed. Run: pip install -r requirements.txt")
        
        self.access_token = access_token or os.getenv('SQUARE_ACCESS_TOKEN')
        if not self.access_token:
            raise ValueError("Square access token not provided. Set SQUARE_ACCESS_TOKEN environment variable.")
        
        self.client = Client(
            access_token=self.access_token,
            environment='production'  # Change to 'sandbox' for testing
        )
        
        # Ensure custom attribute definitions exist
        self._ensure_custom_attribute_definitions()
        
    def _ensure_custom_attribute_definitions(self):
        """Ensure custom attribute definitions exist for escooter fields."""
        # This is a simplified check. In production, you'd cache these IDs.
        # We need to map our keys (escooter1) to Square's Attribute Definition IDs.
        self.attribute_keys = {}
        
        try:
            # List existing definitions
            result = self.client.customer_custom_attributes.list_customer_custom_attribute_definitions()
            
            existing_defs_by_key = {}
            existing_defs_by_name = {}
            if result.is_success():
                defs = result.body.get('custom_attribute_definitions', [])
                print(f"Found {len(defs)} Square custom attribute definitions")
                for definition in defs:
                    k = definition.get('key')
                    n = definition.get('name')
                    id = definition.get('id')
                    existing_defs_by_key[k] = k # Use the key itself for upsert
                    existing_defs_by_name[n] = k
                    print(f"  - Definition: {k} ({n})")
            
            # Match or create definitions
            custom_fields = [
                ('escooter1', 'eScooter 1'),
                ('escooter2', 'eScooter 2'),
                ('escooter3', 'eScooter 3'),
                ('secondary_address', 'Secondary Address'),
                ('webform_notes', 'Webform Notes')
            ]
            
            for key, name in custom_fields:
                
                # Try to match by key first, then by name
                if key in existing_defs_by_key:
                    self.attribute_keys[key] = existing_defs_by_key[key]
                elif name in existing_defs_by_name:
                    self.attribute_keys[key] = existing_defs_by_name[name]
                    print(f"  Matched {key} to existing definition with key {existing_defs_by_name[name]}")
                else:
                    print(f"Creating Square custom attribute definition for {key}...")
                    body = {
                        "custom_attribute_definition": {
                            "key": key,
                            "name": name,
                            "description": f"Custom field for {key}",
                            "visibility": "VISIBILITY_READ_WRITE_VALUES",
                            "schema": {
                                "$ref": "https://developer-production-s.squarecdn.com/schemas/v1/common.json#squareup.common.String"
                            }
                        }
                    }
                    create_result = self.client.customer_custom_attributes.create_customer_custom_attribute_definition(body=body)
                    
                    if create_result.is_success():
                        new_def = create_result.body.get('custom_attribute_definition')
                        self.attribute_keys[key] = new_def.get('key')
                        print(f"  Created {key} with key {new_def.get('key')}")
                    else:
                        print(f"  Error creating {key}: {create_result.errors}")
                        
        except Exception as e:
            print(f"Warning: Could not ensure Square custom attributes: {e}")
            print("  Make sure your token has CUSTOMERS_WRITE and CUSTOMERS_READ permissions.")
    
    def fetch_contacts(self) -> List[Contact]:
        """Fetch all customers from Square."""
        contacts = []
        cursor = None
        
        try:
            while True:
                result = self.client.customers.list_customers(cursor=cursor)
                
                if result.is_success():
                    customers = result.body.get('customers', [])
                    
                    for customer in customers:
                        # Fetch custom attributes for this customer
                        custom_attrs = {}
                        try:
                            cust_id = customer.get('id')
                            if cust_id:
                                attr_result = self.client.customer_custom_attributes.list_customer_custom_attributes(customer_id=cust_id)
                                if attr_result.is_success():
                                    attrs = attr_result.body.get('custom_attributes', [])
                                    # Convert list/dict to a usable dict if needed
                                    for attr in attrs:
                                        key = attr.get('key')
                                        val = attr.get('value')
                                        if key and val is not None:
                                            custom_attrs[key] = val
                        except Exception as attr_e:
                            print(f"Warning: Could not fetch custom attributes for customer {customer.get('id')}: {attr_e}")

                        contact = self._convert_to_contact(customer, custom_attrs)
                        if contact:
                            contacts.append(contact)
                    
                    cursor = result.body.get('cursor')
                    if not cursor:
                        break
                else:
                    print(f"Error fetching Square customers: {result.errors}")
                    break
        
        except Exception as e:
            print(f"Error connecting to Square API: {e}")
        
        return contacts
    
    def _convert_to_contact(self, customer: dict, custom_attrs: dict = None) -> Optional[Contact]:
        """Convert Square customer to Contact."""
        contact = Contact()
        
        # Extract name
        contact.first_name = customer.get('given_name')
        contact.last_name = customer.get('family_name')
        
        # Extract email
        contact.email = customer.get('email_address')
        
        # Extract phone
        contact.phone = customer.get('phone_number')
        
        # Extract company
        contact.company = customer.get('company_name')
        
        # Extract address
        address = customer.get('address')
        if address:
            contact.addresses.append({
                'street': address.get('address_line_1', ''),
                'street2': address.get('address_line_2', ''),
                'city': address.get('locality', ''),
                'state': address.get('administrative_district_level_1', ''),
                'postal_code': address.get('postal_code', ''),
                'country': address.get('country', '')
            })
        
        # Extract notes
        note = customer.get('note')
        if note:
            contact.notes = note
        
        # Extract last modified time
        updated_at = customer.get('updated_at')
        if updated_at:
            # Square format: "2023-11-01T12:00:00Z"
            dt = datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
            contact.last_modified = dt

        # Store Square customer ID
        customer_id = customer.get('id')
        if customer_id:
            contact.source_ids['square'] = customer_id
            
        # Extract custom customer ID from reference_id
        ref_id = customer.get('reference_id')
        if ref_id:
            contact.custom_id = ref_id
            
        # Extract Custom Attributes
        custom_attrs = custom_attrs or customer.get('custom_attributes', {})
        
        if custom_attrs:
             # Reverse mapping for qualified keys
             rev_map = {v: k for k, v in self.attribute_keys.items()}
             
             # Square might store them as a list (from list_customer_custom_attributes) 
             # or a dict (if expanded in other endpoints)
             if isinstance(custom_attrs, list):
                 for attr in custom_attrs:
                     key = attr.get('key')
                     value = attr.get('value')
                     if key and value is not None:
                         # Match literal key OR discovered (qualified) key
                         mapped_key = rev_map.get(key) or (key if key in ['escooter1', 'escooter2', 'escooter3', 'secondary_address', 'webform_notes'] else None)
                         if mapped_key:
                             if mapped_key == 'webform_notes':
                                 contact.notes = str(value)
                             else:
                                 contact.extra_fields[mapped_key] = str(value)
             else:
                 for key, value_obj in custom_attrs.items():
                     val = value_obj.get('value') if isinstance(value_obj, dict) else value_obj
                     mapped_key = rev_map.get(key) or (key if key in ['escooter1', 'escooter2', 'escooter3', 'secondary_address', 'webform_notes'] else None)
                     if mapped_key:
                         if mapped_key == 'webform_notes':
                             contact.notes = str(val)
                         else:
                             contact.extra_fields[mapped_key] = str(val)
        
        return contact if (
            contact.email or 
            contact.normalized_phone or 
            contact.first_name or 
            contact.last_name
        ) else None
    
    def push_contact(self, contact: Contact) -> bool:
        """Push a contact to Square."""
        try:
            # Check if contact already exists in Square
            if 'square' in contact.source_ids:
                # Update existing customer
                self._update_customer(contact)
            else:
                # Create new customer
                self._create_customer(contact)
            return True
        except Exception as e:
            print(f"Error pushing contact to Square: {e}")
            return False
            
    def delete_contact(self, customer_id: str) -> bool:
        """Delete a customer from Square."""
        try:
            result = self.client.customers.delete_customer(customer_id=customer_id)
            if result.is_success():
                print(f"Deleted customer {customer_id} from Square.")
                return True
            else:
                print(f"Error deleting customer from Square: {result.errors}")
                return False
        except Exception as e:
            print(f"Error deleting customer from Square: {e}")
            return False
    
    def _create_customer(self, contact: Contact):
        """Create a new customer in Square."""
        body = self._contact_to_customer(contact)
        
        result = self.client.customers.create_customer(body=body)
        
        if result.is_success():
            customer = result.body.get('customer', {})
            customer_id = customer.get('id')
            contact.source_ids['square'] = customer_id
            # Sync custom attributes separately
            self._sync_custom_attributes(customer_id, contact)
        else:
            print(f"Error creating Square customer: {result.errors}")
    
    def _update_customer(self, contact: Contact):
        """Update an existing customer in Square."""
        customer_id = contact.source_ids['square']
        body = self._contact_to_customer(contact)
        
        result = self.client.customers.update_customer(
            customer_id=customer_id,
            body=body
        )
        
        if result.is_success():
            # Sync custom attributes separately
            self._sync_custom_attributes(customer_id, contact)
        else:
            print(f"Error updating Square customer: {result.errors}")
    
    def _contact_to_customer(self, contact: Contact) -> dict:
        """Convert Contact to Square customer object."""
        customer = {}
        
        # Name
        if contact.first_name:
            customer['given_name'] = contact.first_name
        if contact.last_name:
            customer['family_name'] = contact.last_name
            
        # Custom ID mapped to Square reference_id
        custom_id = getattr(contact, 'custom_id', None)
        if custom_id:
            customer['reference_id'] = custom_id
        
        # Email
        if contact.email:
            customer['email_address'] = contact.email
        
        # Phone
        if contact.phone:
            customer['phone_number'] = contact.phone
        
        # Company
        if contact.company:
            customer['company_name'] = contact.company
        
        # Address
        if contact.addresses:
            addr = contact.addresses[0]  # Square supports one address
            # Square requires ISO-3166-1 alpha-2 codes (e.g. 'AU' instead of 'Australia')
            country = addr.get('country', 'AU')
            if country == 'Australia':
                country = 'AU'
            elif not country or len(country) > 2:
                # Fallback to AU for this specific user's context if invalid/full name
                country = 'AU'
                
            customer['address'] = {
                'address_line_1': addr.get('street', ''),
                'address_line_2': addr.get('street2', ''),
                'locality': addr.get('city', ''),
                'administrative_district_level_1': addr.get('state', ''),
                'postal_code': addr.get('postal_code', ''),
                'country': country
            }
        
        # Notes (Bypassing native Square notes as it maps to 'Other' which is uneditable, we use custom attributes instead)
        # if contact.notes:
        #     customer['note'] = contact.notes[:500]
            
        return customer

    def _sync_custom_attributes(self, customer_id: str, contact: Contact):
        """Sync custom attributes for a customer using the upsert endpoint."""
        attrs_to_sync = {k: v for k, v in contact.extra_fields.items() if k in ['escooter1', 'escooter2', 'escooter3', 'secondary_address']}
        if contact.notes is not None:
            attrs_to_sync['webform_notes'] = contact.notes
            
        if not attrs_to_sync:
            return

        print(f"Syncing {len(attrs_to_sync)} custom attributes for Square customer {customer_id}...")
        for key, value in attrs_to_sync.items():
            if value is None:
                continue
                
            # Use the discovered key (which might be a qualified key like 'square:xxx')
            sync_key = self.attribute_keys.get(key, key)
            
            try:
                # If the string is explicitly empty, Square requires a delete operation
                if value == "":
                    print(f"  Deleting {sync_key} (from {key})...")
                    result = self.client.customer_custom_attributes.delete_customer_custom_attribute(
                        customer_id=customer_id,
                        key=sync_key
                    )
                    if result.is_success():
                        print(f"    ✓ Successfully deleted {key}")
                    else:
                        print(f"    ✗ Failed to delete {key}: {result.errors}")
                else:
                    body = {
                        "custom_attribute": {
                            "value": str(value)
                        }
                    }
                    print(f"  Upserting {sync_key} (from {key}) = '{value}'...")
                    result = self.client.customer_custom_attributes.upsert_customer_custom_attribute(
                        customer_id=customer_id,
                        key=sync_key,
                        body=body
                    )
                    if result.is_success():
                        print(f"    ✓ Successfully synced {key}")
                    else:
                        print(f"    ✗ Failed to sync {key} using key {sync_key}: {result.errors}")
            except Exception as e:
                print(f"    ✗ Error syncing Square attribute {key} ({sync_key}): {e}")
