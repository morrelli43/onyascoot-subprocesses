"""
Sync engine for coordinating contact synchronization in V2 architecture.
"""
from typing import List, Dict
import threading

from contact_model import Contact, ContactStore

class SyncEngine:
    """Coordinates contact synchronization across multiple sources in memory."""
    
    def __init__(self):
        self.store = ContactStore()
        self.connectors = {}
        self.lock = threading.Lock()
    
    def register_connector(self, name: str, connector):
        """Register a contact source connector."""
        self.connectors[name] = connector

    def _ensure_custom_id(self, contact: Contact):
        """Ensure a contact has a custom cst-XXXXXXXXX ID (Exactly 13 chars)."""
        import random
        cid = getattr(contact, 'custom_id', None)
        # If it's missing, empty, or not the new 9-digit format (cst- + 9 digits = 13 chars)
        if not cid or not str(cid).startswith("cst-") or len(str(cid)) != 13:
            old_id = cid
            contact.custom_id = f"cst-{random.randint(100000000, 999999999)}"
            print(f"  [ID_GEN] Assigned {contact.custom_id} to {contact.first_name} {contact.last_name} (Previous: {old_id})")
    
    def process_incoming_webhook(self, data: dict, source_name: str = 'webform'):
        """
        Process an incoming webhook/webform and instantly push to destinations.
        """
        if not self.lock.acquire(blocking=False):
            print("Sync in progress, delaying webhook processing...")
            self.lock.acquire() # block until done
            
        try:
            print(f"Processing incoming {source_name} data...")
            contact = Contact()
            contact.first_name = data.get('first_name', '')
            contact.last_name = data.get('last_name') or data.get('surname', '')
            contact.phone = data.get('phone') or data.get('number', '')
            contact.email = data.get('email', '')
            contact.company = data.get('company', '')
            contact.notes = data.get('notes') or data.get('issue', '')
            
            # Map address
            address = data.get('address') or data.get('address_line_1', '')
            suburb = data.get('suburb', '')
            state = data.get('state', 'Victoria')
            postcode = data.get('postcode', '')
            country = data.get('country', 'AU')
            
            if address or suburb or postcode:
                contact.addresses.append({
                    'street': address,
                    'city': suburb,
                    'state': state,
                    'postal_code': postcode,
                    'country': country
                })
                
            # Escooters
            escooter_val = data.get('escooter1') or data.get('escooter')
            if not escooter_val:
                scooter_name = data.get('scooter_name') or data.get('make', '')
                scooter_model = data.get('scooter_model') or data.get('model', '')
                if scooter_name or scooter_model:
                    escooter_val = f"{scooter_name} {scooter_model}".strip()
            
            if escooter_val:
                contact.extra_fields['escooter1'] = escooter_val
            
            for i in range(2, 4):
                key = f'escooter{i}'
                if data.get(key):
                    contact.extra_fields[key] = data[key]
                    
            # Set memory ID
            import time
            contact.source_ids[source_name] = str(time.time())
            
            # Ensure custom ID (cst-XXXXXX) is assigned immediately
            self._ensure_custom_id(contact)
            
            # Drop the webform directly into the store so it has memory presence
            # then instantly push to Square.
            if not contact.normalized_phone:
                print("WARNING: Webhook payload missing parseable phone, dropping.")
                return False
                
            # Webforms are authoritative for the data they PROVIDE, but they 
            # should trigger a Square push.
            self.store.add_contact(contact, source_of_truth=source_name, authoritative=True)
            
            # Instant Push to Square only.
            # The Square webhook will fire back and trigger a full sync to Google.
            if 'square' in self.connectors and hasattr(self.connectors['square'], 'push_contact'):
                print(f"Pushing webhook contact to Square...")
                self.connectors['square'].push_contact(contact)
                    
            return True
        finally:
            self.lock.release()

    def _contact_from_ops_payload(self, payload: dict) -> Contact:
        """Map an Operations customer payload to canonical Contact."""
        contact = Contact()
        contact.custom_id = str(payload.get('customer_uid') or payload.get('customerUid') or '').strip() or None

        contact.first_name = payload.get('first_name') or payload.get('firstName') or ''
        contact.last_name = payload.get('surname') or payload.get('last_name') or payload.get('lastName') or ''
        contact.phone = payload.get('number') or payload.get('phone') or payload.get('customer_phone') or ''
        contact.email = payload.get('email') or payload.get('customer_email') or ''
        contact.company = payload.get('company') or ''
        contact.notes = payload.get('issue_extra') or payload.get('issue') or payload.get('notes') or ''

        address_line = payload.get('address_line_1') or payload.get('address') or payload.get('addressLine1') or ''
        suburb = payload.get('suburb') or payload.get('city') or ''
        state = payload.get('state') or 'VIC'
        postcode = payload.get('postcode') or payload.get('postal_code') or payload.get('postalCode') or ''
        country = payload.get('country') or 'AU'
        if address_line or suburb or postcode:
            contact.addresses = [{
                'street': address_line,
                'city': suburb,
                'state': state,
                'postal_code': postcode,
                'country': country,
            }]

        make = payload.get('escooter_make') or payload.get('scooter_make') or payload.get('scooterMake') or ''
        model = payload.get('escooter_model') or payload.get('scooter_model') or payload.get('scooterModel') or ''
        escooter = payload.get('escooter') or payload.get('escooter1') or payload.get('scooter') or ''
        if not escooter:
            escooter = f"{make} {model}".strip()
        if escooter:
            contact.extra_fields['escooter1'] = escooter

        return contact

    def upsert_contact_from_operations(self, payload: dict) -> dict:
        """Upsert a contact in Google from Operations payload using customer_uid as stable key."""
        if 'google' not in self.connectors:
            raise RuntimeError('Google connector not configured')

        customer_uid = str(payload.get('customer_uid') or payload.get('customerUid') or '').strip()
        if not customer_uid:
            raise ValueError('Missing customer_uid (or customerUid)')

        with self.lock:
            contact = self._contact_from_ops_payload(payload)

            # Try deterministic lookup by customer_uid first.
            existing_google = None
            google_contacts = self.connectors['google'].fetch_contacts()
            for gc in google_contacts:
                if getattr(gc, 'custom_id', None) == customer_uid:
                    existing_google = gc
                    break

            # Fallback for older records that may predate customer_uid tagging.
            if not existing_google:
                incoming_phone = contact.normalized_phone
                incoming_email = (contact.email or '').lower().strip()
                for gc in google_contacts:
                    if incoming_phone and gc.normalized_phone == incoming_phone:
                        existing_google = gc
                        break
                    if incoming_email and gc.email and gc.email.lower().strip() == incoming_email:
                        existing_google = gc
                        break

            if existing_google and existing_google.source_ids.get('google'):
                contact.source_ids['google'] = existing_google.source_ids.get('google')

            ok = self.connectors['google'].push_contact(contact)
            if not ok:
                raise RuntimeError('Google push_contact returned false')

            return {
                'status': 'ok',
                'action': 'upsert',
                'customer_uid': customer_uid,
                'google_resource': contact.source_ids.get('google')
            }

    def delete_contact_from_operations(self, payload: dict) -> dict:
        """Delete a Google contact by Operations customer_uid."""
        if 'google' not in self.connectors:
            raise RuntimeError('Google connector not configured')

        customer_uid = str(payload.get('customer_uid') or payload.get('customerUid') or '').strip()
        if not customer_uid:
            raise ValueError('Missing customer_uid (or customerUid)')

        with self.lock:
            google_contacts = self.connectors['google'].fetch_contacts()
            target = None
            for gc in google_contacts:
                if getattr(gc, 'custom_id', None) == customer_uid:
                    target = gc
                    break

            if not target or not target.source_ids.get('google'):
                return {
                    'status': 'not_found',
                    'action': 'delete',
                    'customer_uid': customer_uid
                }

            ok = self.connectors['google'].delete_contact(target.source_ids['google'])
            if not ok:
                raise RuntimeError('Google delete_contact returned false')

            return {
                'status': 'deleted',
                'action': 'delete',
                'customer_uid': customer_uid,
                'google_resource': target.source_ids['google']
            }

    def sync_all(self) -> bool:
        """Perform a full synchronization cycle explicitly weighting Square when enabled."""
        if not self.lock.acquire(blocking=False):
            print("Sync already in progress, skipping this trigger.")
            return False
            
        try:
            print("=" * 60)
            print("Starting v2.4.0 synchronization cycle")
            print("=" * 60)
            
            self.store.clear()
            
            # 1. Fetch Square (Source of Truth)
            square_members = {
                'ids': set(),
                'phones': set(),
                'emails': set()
            }
            if 'square' in self.connectors:
                print("Fetching contacts from Square (Source of Truth)...")
                try:
                    square_contacts = self.connectors['square'].fetch_contacts()
                    for c in square_contacts:
                        # Snaphot the exact payload Square gave us
                        c._original_square_payload = self.connectors['square']._contact_to_customer(c)
                        c._original_square_attrs = {k: v for k, v in c.extra_fields.items() if k in ['escooter1', 'escooter2', 'escooter3']}
                        try:
                            added_id = self.store.add_contact(c, source_of_truth='square', authoritative=True)
                            if added_id:
                                 # Preserve original payloads on the canonical contact in our temporary store
                                 self.store.contacts[added_id]._original_square_payload = c._original_square_payload
                                 self.store.contacts[added_id]._original_square_attrs = c._original_square_attrs

                            # Track all identifiers for orphan detection
                            sq_id = c.source_ids.get('square')
                            if sq_id: square_members['ids'].add(sq_id)
                            if c.normalized_phone: square_members['phones'].add(c.normalized_phone)
                            if c.email: square_members['emails'].add(c.email.lower().strip())
                        except Exception as inner_e:
                            print(f"  [CRITICAL] Failed to process Square contact {c.first_name} {c.last_name}: {inner_e}")

                    print(f"  Loaded {len(square_contacts)} Square contacts into memory.")
                except Exception as e:
                    print(f"  Error fetching from Square: {e}")
                    
            # 2. Fetch Google Contacts 
            google_contacts = []
            if 'google' in self.connectors:
                print("Fetching contacts from Google...")
                try:
                    google_contacts = self.connectors['google'].fetch_contacts()
                    for c in google_contacts:
                        # Snapshot the exact payload Google gave us
                        c._original_google_payload = self.connectors['google']._contact_to_person(c)
                        # Add them, enforcing Square as the persistent source of truth
                        # Google is a MIRROR, so authoritative=False
                        added_id = self.store.add_contact(c, source_of_truth='square', authoritative=False)
                        
                        # Store the google payload on the unified canonical object so we can dirty-check later
                        self.store.contacts[added_id]._original_google_payload = c._original_google_payload
                    print(f"  Loaded {len(google_contacts)} Google contacts.")
                except Exception as e:
                    print(f"  Error fetching from Google: {e}")
                    print("  Aborting sync to prevent duplication issues.")
                    return False
            # 2.5. Orphan Detection: delete Google contacts no longer in Square
            if 'google' in self.connectors and 'square' in self.connectors:
                self._delete_google_orphans(google_contacts, square_members)
            
            # 3. Push Unified Data Back to ALL Sources
            unified_contacts = self.store.get_all_contacts()
            success = self.push_to_all_sources(unified_contacts)
            
            print("\n" + "=" * 60)
            print(f"v2.4.0 Synchronization cycle completed. {len(unified_contacts)} unique contacts.")
            print("=" * 60)
            return success
            
        finally:
            self.lock.release()
    
    def _delete_google_orphans(self, google_contacts: List[Contact], square_members: Dict[str, set]):
        """Delete Google contacts that no longer exist in Square.
        
        Only deletes contacts that have been identified as originating from Square.
        
        Args:
            google_contacts: Contacts fetched from Google this cycle.
            square_members: Dict containing sets of 'ids', 'phones', and 'emails' from Square.
        """
        
        deleted_count = 0
        for gc in google_contacts:
            google_resource = gc.source_ids.get('google')
            square_id = gc.source_ids.get('square')
            phone = gc.normalized_phone
            email = gc.email.lower().strip() if gc.email else None
            
            # Safety: only delete if the contact has a Square ID link
            if not square_id:
                continue
            
            # Check if this contact matches ANY existing Square contact
            is_present_in_square = (
                square_id in square_members['ids'] or
                (phone and phone in square_members['phones']) or
                (email and email in square_members['emails'])
            )
            
            if not is_present_in_square:
                print(f"  Orphan detected: {gc.first_name} {gc.last_name} ({square_id}) - deleting from Google")
                try:
                    if self.connectors['google'].delete_contact(google_resource):
                        deleted_count += 1
                        # Also remove from in-memory store
                        to_remove = [cid for cid, c in self.store.contacts.items() 
                                     if c.source_ids.get('square') == square_id]
                        for cid in to_remove:
                            self.store.remove_contact(cid)
                except Exception as e:
                    print(f"  Error deleting orphan from Google: {e}")
        
        if deleted_count:
            print(f"  Deleted {deleted_count} orphaned Google contact(s).")

    def handle_square_deletion(self, square_customer_id: str):
        """Handle a customer.deleted webhook from Square.
        
        Finds the matching Google contact and deletes it.
        """
        if 'google' not in self.connectors:
            print("  No Google connector registered, skipping deletion propagation.")
            return
        
        with self.lock:
            print(f"\nHandling Square deletion for customer ID: {square_customer_id}")
            
            try:
                # With `square_id` natively stored in Google Custom Fields, 
                # we can fetch Google directly and find the deterministic match.
                google_contacts = self.connectors['google'].fetch_contacts()
            except Exception as e:
                print(f"  Error fetching Google contacts for deletion: {e}")
                return
            
            # Find the Google contact that was synced from this Square customer
            for gc in google_contacts:
                if gc.source_ids.get('square') == square_customer_id:
                    google_resource = gc.source_ids.get('google')
                    if google_resource:
                        print(f"  Found matching Google contact: {gc.first_name} {gc.last_name}")
                        try:
                            self.connectors['google'].delete_contact(google_resource)
                            # Remove it from our script memory as well
                            for mem_id, pc in list(self.store.contacts.items()):
                                if pc.source_ids.get('square') == square_customer_id:
                                    self.store.remove_contact(mem_id)
                        except Exception as e:
                            print(f"  Error deleting from Google: {e}")
                    return
            
            print(f"  No matching Google contact found for Square customer {square_customer_id}")

    def push_to_all_sources(self, contacts: List[Contact]) -> bool:
        print("\nPushing normalized contacts back to all destinations...")
        success = True
        
        # Ensure every contact gets a unique custom ID assigned before pushing
        for contact in contacts:
            self._ensure_custom_id(contact)
        
        
        for source_name, connector in self.connectors.items():
            if not hasattr(connector, 'push_contact'):
                continue
            
            print(f"Pushing to {source_name}...")
            pushed = 0
            errors = 0
            
            for contact in contacts:
                # Do not push contacts that have absolutely no usable contact info
                if not contact.normalized_phone and not contact.email and not contact.first_name and not contact.last_name:
                    continue
                    
                # Intelligent dirty checking to prevent infinite loops and API burning
                try:
                    name_dbg = f"{contact.first_name} {contact.last_name}"
                    if source_name == 'square':
                        new_sq_payload = connector._contact_to_customer(contact)
                        new_sq_attrs = {k: v for k, v in contact.extra_fields.items() if k in ['escooter1', 'escooter2', 'escooter3']}
                        
                        orig_sq_payload = getattr(contact, '_original_square_payload', None)
                        orig_sq_attrs = getattr(contact, '_original_square_attrs', None)
                        
                        if orig_sq_payload is not None and orig_sq_payload == new_sq_payload and orig_sq_attrs == new_sq_attrs:
                            # print(f"  Skipping {name_dbg}... no changes for Square.")
                            continue
                        
                        if orig_sq_payload is None:
                            print(f"  Contact {name_dbg} is new to Square, pushing...")
                        else:
                            print(f"  Contact {name_dbg} changed in Square, pushing...")
                            
                    elif source_name == 'google':
                        new_go_payload = connector._contact_to_person(contact)
                        orig_go_payload = getattr(contact, '_original_google_payload', None)
                        
                        if orig_go_payload is not None and orig_go_payload == new_go_payload:
                            # Too much noise to log every single skip, but let's log if it was a source of truth change
                            # print(f"  Skipping {name_dbg}... no changes for Google.")
                            continue
                            
                        if orig_go_payload is None:
                            print(f"  Contact {name_dbg} is new to Google, pushing...")
                        else:
                            print(f"  Contact {name_dbg} changed for Google, pushing update...")
                except Exception as e:
                    print(f"  Warning during diff check for {name_dbg}: {e}")

                try:
                    if connector.push_contact(contact):
                        pushed += 1
                    else:
                        errors += 1
                except Exception as e:
                    print(f"  Error pushing contact {name_dbg}: {e}")
                    errors += 1
                    success = False
            
            print(f"  Pushed {pushed} contacts to {source_name}, {errors} errors")
        
        return success
