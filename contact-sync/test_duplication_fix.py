
import sys
import os
from datetime import datetime, timezone

# Add the contact-sync directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'contact-sync')))

from contact_model import Contact, ContactStore

def test_duplication_and_unbound_error():
    print("Testing Georgia Duplication and UnboundLocalError fixes...\n")
    
    store = ContactStore()
    
    # 1. Test Georgia Duplication Fix (Name Matching)
    # ---------------------------------------------
    print("Scenario 1: Name-based matching for 'Georgia .'")
    
    # First entry from Google (has the dot)
    c1 = Contact()
    c1.first_name = "Georgia"
    c1.last_name = "."
    c1.source_ids['google'] = 'google_id_123'
    store.add_contact(c1, source_of_truth='square', authoritative=False)
    
    print(f"  Added initial contact: {c1.first_name} {c1.last_name}")
    
    # Second entry from Square (no dot, also no phone/email)
    c2 = Contact()
    c2.first_name = "Georgia"
    c2.source_ids['square'] = 'square_id_456'
    
    print(f"  Attempting to add duplicate from Square: {c2.first_name} {c2.last_name or ''}")
    
    added_id = store.add_contact(c2, source_of_truth='square', authoritative=True)
    
    # Verify they merged
    contacts = store.get_all_contacts()
    print(f"  Total unique contacts in store: {len(contacts)}")
    
    if len(contacts) == 1:
        print("  ✅ SUCCESS: Georgia correctly merged via name-based fallback.")
    else:
        print("  ❌ FAILURE: Duplicate Georgia created.")
        sys.exit(1)
        
    # Verify normalization worked
    merged = contacts[0]
    if merged.source_ids.get('square') == 'square_id_456' and merged.source_ids.get('google') == 'google_id_123':
        print("  ✅ SUCCESS: Source IDs correctly merged.")
    else:
        print(f"  ❌ FAILURE: Source IDs missing. IDs: {merged.source_ids}")
        sys.exit(1)

    # 2. Test UnboundLocalError Fix
    # -----------------------------
    print("\nScenario 2: UnboundLocalError verification")
    
    try:
        # Create a merge scenario that might trigger it
        target = Contact()
        source = Contact()
        # Ensure source_of_truth is NOT in either source_ids to hit the 'else' block logic
        target.merge_with(source, source_of_truth='something_else')
        print("  ✅ SUCCESS: merge_with executed without UnboundLocalError.")
    except UnboundLocalError as e:
        print(f"  ❌ FAILURE: Caught UnboundLocalError: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"  ❌ FAILURE: Caught unexpected error: {e}")
        sys.exit(1)

    # 3. Test Safety for missing source_ids
    # ------------------------------------
    print("\nScenario 3: Safety verification for missing source_ids")
    try:
        c_no_ids = Contact()
        del c_no_ids.source_ids # simulate missing attribute or None
        target = Contact()
        target.merge_with(c_no_ids, source_of_truth='square')
        print("  ✅ SUCCESS: merge_with handled missing source_ids safely.")
    except Exception as e:
        print(f"  ❌ FAILURE: merge_with crashed on missing source_ids: {e}")
        sys.exit(1)

if __name__ == "__main__":
    test_duplication_and_unbound_error()
