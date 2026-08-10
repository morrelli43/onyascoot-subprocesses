import unittest
from contact_model import Contact, ContactStore
from google_connector import GoogleContactsConnector
from sync_engine import SyncEngine

class TestEscooterFeatures(unittest.TestCase):
    """Test suite for eScooter organization name, custom fields, secondary address, and job notes."""

    def test_escooter_in_business_name_google(self):
        connector = GoogleContactsConnector.__new__(GoogleContactsConnector)
        
        contact = Contact()
        contact.first_name = "Robert"
        contact.last_name = "Druch"
        contact.extra_fields['escooter1'] = "Inmotion RS Lite"
        
        person = connector._contact_to_person(contact)
        orgs = person.get('organizations', [])
        
        self.assertEqual(len(orgs), 1)
        self.assertEqual(orgs[0].get('name'), "Inmotion RS Lite")

    def test_multi_escooter_custom_fields(self):
        connector = GoogleContactsConnector.__new__(GoogleContactsConnector)
        
        contact = Contact()
        contact.first_name = "Robert"
        contact.last_name = "Druch"
        contact.extra_fields['escooter1'] = "Inmotion RS Lite"
        contact.extra_fields['escooter2'] = "Xiaomi S1"
        contact.extra_fields['escooter3'] = "Segway Max G2"
        
        person = connector._contact_to_person(contact)
        user_defined = {f['key']: f['value'] for f in person.get('userDefined', [])}
        
        self.assertEqual(user_defined.get('escooter1'), "Inmotion RS Lite")
        self.assertEqual(user_defined.get('escooter2'), "Xiaomi S1")
        self.assertEqual(user_defined.get('escooter3'), "Segway Max G2")

    def test_secondary_address_custom_field(self):
        connector = GoogleContactsConnector.__new__(GoogleContactsConnector)
        
        contact = Contact()
        contact.first_name = "Robert"
        contact.last_name = "Druch"
        contact.extra_fields['secondary_address'] = "Unit 4, 123 Beach Rd, St Kilda VIC 3182"
        
        person = connector._contact_to_person(contact)
        user_defined = {f['key']: f['value'] for f in person.get('userDefined', [])}
        
        self.assertEqual(user_defined.get('secondary_address'), "Unit 4, 123 Beach Rd, St Kilda VIC 3182")
        
        # Test converting back from person
        converted = connector._convert_to_contact(person)
        self.assertEqual(converted.extra_fields.get('secondary_address'), "Unit 4, 123 Beach Rd, St Kilda VIC 3182")

    def test_completed_job_notes_formatting(self):
        engine = SyncEngine()
        payload = {
            "first_name": "Robert",
            "surname": "Druch",
            "number": "0412345678",
            "escooter1": "Inmotion RS Lite",
            "job_date": "2026-08-10",
            "job_price": "150.00",
            "job_service": "New scooter assembly and diagnostic"
        }
        
        contact = engine._contact_from_ops_payload(payload)
        self.assertIn("[2026-08-10] Inmotion RS Lite: New scooter assembly and diagnostic ($150.00)", contact.notes)

if __name__ == '__main__':
    unittest.main()
