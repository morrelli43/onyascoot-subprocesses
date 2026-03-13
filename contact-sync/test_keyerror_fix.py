
import sys
import os

# Add the contact-sync directory to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), 'contact-sync')))

from contact_model import Contact, ContactStore

def test_keyerror_fix():
    print("Testing KeyError: 'contact_X' index discrepancy fix...\n")
    
    store = ContactStore()
    
    # 1. Reproduce Scenario: Manually create a stale index
    # ---------------------------------------------------
    # Create contact_1
    c1 = Contact()
    c1.first_name = "Stale"
    c1.last_name = "Contact"
    c1.phone = "0411111111"
    store.add_contact(c1)
    
    print(f"  Added contact: {c1.contact_id} ({c1.first_name})")
    
    # Simulate the BUG: Direct deletion without index cleanup
    del store.contacts['contact_1']
    print("  SIMULATED BUG: Deleted 'contact_1' directly from store.contacts, leaving phone index stale.")
    
    # Now try to add a new contact with the SAME phone
    c2 = Contact()
    c2.first_name = "New"
    c2.last_name = "Contact"
    c2.phone = "0411111111"
    
    print(f"  Attempting to add new contact with same phone: {c2.phone}")
    
    try:
        # This used to crash with KeyError: 'contact_1' inside add_contact -> merge_with
        new_id = store.add_contact(c2)
        print(f"  ✅ SUCCESS: add_contact processed safely. Assigned ID: {new_id}")
    except KeyError as e:
        print(f"  ❌ FAILURE: Caught KeyError during add_contact: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"  ❌ FAILURE: Caught unexpected error: {e}")
        sys.exit(1)
        
    # 2. Test proper removal
    # ----------------------
    print("\nScenario 2: Proper removal using remove_contact")
    c3 = Contact()
    c3.first_name = "Removable"
    c3.phone = "0422222222"
    cid3 = store.add_contact(c3)
    
    print(f"  Added contact: {cid3}")
    print(f"  Phone index before: {store.phone_index.get('0422222222')}")
    
    store.remove_contact(cid3)
    print(f"  Called remove_contact('{cid3}')")
    
    phone_idx = store.phone_index.get('0422222222')
    print(f"  Phone index after: {phone_idx}")
    
    if phone_idx is None:
        print("  ✅ SUCCESS: Index correctly cleaned up.")
    else:
        print(f"  ❌ FAILURE: Stale index remained: {phone_idx}")
        sys.exit(1)

    print("\n🎉 KeyError fix and safe removal verified!")

if __name__ == "__main__":
    test_keyerror_fix()
