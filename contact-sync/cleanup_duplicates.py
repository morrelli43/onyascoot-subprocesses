import time
from google_connector import GoogleContactsConnector
from googleapiclient.errors import HttpError

def clean_google_duplicates():
    print("Connecting to Google Contacts...")
    connector = GoogleContactsConnector()
    connector.authenticate()
    
    print("Fetching contacts. This could take a while for 4000+ contacts...")
    contacts = []
    page_token = None
    while True:
        results = connector.service.people().connections().list(
            resourceName='people/me',
            pageSize=1000,
            personFields='names,emailAddresses,phoneNumbers,userDefined',
            pageToken=page_token
        ).execute()
        
        connections = results.get('connections', [])
        contacts.extend(connections)
        
        page_token = results.get('nextPageToken')
        if not page_token:
            break

    print(f"Fetched {len(contacts)} contacts. Finding duplicates...")
    
    # Group by name + email + phone + square_id to be extra safe
    seen = {}
    to_delete = []
    
    for person in contacts:
        name = ""
        if person.get('names'):
            name = person['names'][0].get('displayName', '')
            
        email = ""
        if person.get('emailAddresses'):
            email = person['emailAddresses'][0].get('value', '').lower()
            
        phone = ""
        if person.get('phoneNumbers'):
            # prefer canonicalForm, fallback to raw value
            phone = person['phoneNumbers'][0].get('canonicalForm', '') or person['phoneNumbers'][0].get('value', '')
            
        square_id = ""
        user_defined = person.get('userDefined', [])
        for field in user_defined:
            if field.get('key') == 'square_id':
                square_id = field.get('value', '')
                break
                
        key = f"{name}|{email}|{phone}|{square_id}"
        
        resource_name = person.get('resourceName')
        if not resource_name:
            continue
            
        if key in seen:
            to_delete.append(resource_name)
        else:
            seen[key] = True

    print(f"Found {len(to_delete)} duplicates to delete out of {len(contacts)} total contacts.")
    
    if to_delete:
        print("Starting deletion...")
        deleted = 0
        for idx, res_name in enumerate(to_delete):
            try:
                connector.service.people().deleteContact(resourceName=res_name).execute()
                deleted += 1
                if deleted % 50 == 0:
                    print(f"Deleted {deleted}/{len(to_delete)}...")
                # Rate limit is 30 QPS max per user usually, but let's be safe
                time.sleep(0.3)
            except HttpError as e:
                # 429 quota handling
                print(f"HTTP Error: {e.status_code}. Sleeping for 2 seconds...")
                time.sleep(2)
            except Exception as e:
                print(f"Error deleting {res_name}: {e}")
                
        print(f"Finished! Successfully deleted {deleted} duplicates.")
    else:
        print("No duplicates found.")

if __name__ == '__main__':
    clean_google_duplicates()
