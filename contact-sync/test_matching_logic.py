
import unittest
from datetime import datetime, timedelta, timezone
from contact_model import Contact, ContactStore

class TestMatchingLogic(unittest.TestCase):
    def setUp(self):
        self.store = ContactStore()

    def test_match_by_phone(self):
        c1 = Contact()
        c1.first_name = "Alice"
        c1.phone = "0400000001"
        c1.last_modified = datetime.now(timezone.utc) - timedelta(hours=1)
        self.store.add_contact(c1)

        c2 = Contact()
        c2.first_name = "Alice Updated"
        c2.phone = "0400000001"
        c2.last_modified = datetime.now(timezone.utc)
        cid = self.store.add_contact(c2)

        self.assertEqual(len(self.store.contacts), 1)
        self.assertEqual(self.store.contacts[cid].first_name, "Alice Updated")

    def test_match_by_email(self):
        c1 = Contact()
        c1.first_name = "Bob"
        c1.email = "bob@example.com"
        c1.last_modified = datetime.now(timezone.utc) - timedelta(hours=1)
        self.store.add_contact(c1)

        c2 = Contact()
        c2.first_name = "Bob Updated"
        c2.email = "bob@example.com"
        c2.last_modified = datetime.now(timezone.utc)
        cid = self.store.add_contact(c2)

        self.assertEqual(len(self.store.contacts), 1)
        self.assertEqual(self.store.contacts[cid].first_name, "Bob Updated")

    def test_match_by_square_id(self):
        c1 = Contact()
        c1.first_name = "Charlie"
        c1.source_ids['square'] = "sq_charli"
        c1.last_modified = datetime.now(timezone.utc) - timedelta(hours=1)
        self.store.add_contact(c1)

        c2 = Contact()
        c2.first_name = "Charlie Updated"
        c2.source_ids['square'] = "sq_charli"
        c2.last_modified = datetime.now(timezone.utc)
        cid = self.store.add_contact(c2)

        self.assertEqual(len(self.store.contacts), 1)
        self.assertEqual(self.store.contacts[cid].first_name, "Charlie Updated")

    def test_match_by_custom_id(self):
        c1 = Contact()
        c1.first_name = "David"
        c1.custom_id = "cst-123456789"
        c1.last_modified = datetime.now(timezone.utc) - timedelta(hours=1)
        self.store.add_contact(c1)

        c2 = Contact()
        c2.first_name = "David Updated"
        c2.custom_id = "cst-123456789"
        c2.last_modified = datetime.now(timezone.utc)
        cid = self.store.add_contact(c2)

        self.assertEqual(len(self.store.contacts), 1)
        self.assertEqual(self.store.contacts[cid].first_name, "David Updated")

    def test_merge_no_phone(self):
        # The specific case reported by the user
        c1_sq = Contact()
        c1_sq.first_name = "Georige"
        c1_sq.last_name = "."
        c1_sq.source_ids['square'] = "sq_georige"
        self.store.add_contact(c1_sq, source_of_truth='square')

        c1_go = Contact()
        c1_go.first_name = "Georige"
        c1_go.last_name = "."
        c1_go.source_ids['square'] = "sq_georige"
        c1_go.source_ids['google'] = "goog_georige"
        cid = self.store.add_contact(c1_go, source_of_truth='square', authoritative=False)

        self.assertEqual(len(self.store.contacts), 1)
        self.assertEqual(self.store.contacts[cid].source_ids['google'], "goog_georige")
        self.assertEqual(self.store.contacts[cid].source_ids['square'], "sq_georige")

if __name__ == "__main__":
    unittest.main()
