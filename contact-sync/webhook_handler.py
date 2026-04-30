"""
Webhook and Webform listener for V2 architecture.
Combines all POST endpoints into a single memory-first Flask app.
"""
from flask import Flask, request, jsonify
import hmac
import hashlib
import os

class WebhookServer:
    def __init__(self, sync_engine, port=7173):
        self.app = Flask(__name__)
        self.port = port
        self.engine = sync_engine
        
        # Square config
        self.square_signature_key = os.getenv('SQUARE_SIGNATURE_KEY')
        self.square_webhook_url = os.getenv('SQUARE_WEBHOOK_URL')

        # Register Routes
        self.app.route('/health', methods=['GET'])(self.health_check)
        self.app.route('/sync', methods=['GET', 'POST'])(self.trigger_sync)
        self.app.route('/send-it', methods=['POST', 'OPTIONS'])(self.handle_webform)
        self.app.route('/webhooks/square', methods=['POST'])(self.handle_square)
        self.app.route('/ops-contact-sync', methods=['POST'])(self.handle_ops_contact_sync)
        self.app.route('/webhooks/operations/contact', methods=['POST'])(self.handle_ops_contact_sync)
        self.app.route('/cleanup-duplicates', methods=['GET', 'POST'])(self.trigger_cleanup)

    def health_check(self):
        return jsonify({"status": "ok", "version": "v2.4.0"}), 200

    def trigger_sync(self):
        """Manually trigger a full sync pass in the background."""
        import threading
        threading.Thread(target=self.engine.sync_all).start()
        return jsonify({"status": "success", "message": "Manual sync triggered in background"}), 200

    def trigger_cleanup(self):
        """Manually trigger Google contacts deduplication in the background."""
        import threading
        def _run_cleanup():
            try:
                import cleanup_duplicates
                cleanup_duplicates.clean_google_duplicates()
            except Exception as e:
                print(f"Error in cleanup background task: {e}")
                
        threading.Thread(target=_run_cleanup, daemon=True).start()
        return jsonify({"status": "success", "message": "Google Contacts duplicate cleanup started in the background. It may take 15-20 minutes to complete. Check container logs for progress."}), 200

    def handle_webform(self):
        """Immediately parse and drop webforms into the sync engine memory."""
        if request.method == 'OPTIONS':
            return '', 204

        try:
            # Handle JSON or Form-Data
            if request.is_json:
                data = request.json
            else:
                data = request.form.to_dict()

            print(f"\n[WebhookServer] Received /send-it payload: {data.get('email', 'No email')} / {data.get('phone', 'No phone')}")
            
            # Immediately hand off to engine for memory parsing and instapush
            success = self.engine.process_incoming_webhook(data, source_name='webform')
            
            if success:
                return jsonify({"status": "success", "message": "Contact pushed instantly."}), 200
            else:
                return jsonify({"status": "error", "message": "Processing failed or missing required fields"}), 400

        except Exception as e:
            print(f"[WebhookServer] Error processing /send-it: {e}")
            return jsonify({"status": "error", "message": str(e)}), 500

    def handle_square(self):
        """Process real-time Square customer events."""
        print("\n[WebhookServer] Received Square Event")
        
        try:
            signature = request.headers.get('x-square-hmacsha256-signature')
            if self.square_signature_key and self.square_webhook_url:
                if not signature or not self._verify_square_signature(request.get_data(), signature):
                    print("  Invalid Square signature")
                    return jsonify({'error': 'Unauthorized'}), 401
                    
            payload = request.get_json(silent=True)
            if not payload:
                print("  Empty or invalid JSON payload")
                return jsonify({'status': 'ignored', 'reason': 'no_json'}), 200
                
            event_type = payload.get('type')
            merchant_id = payload.get('merchant_id', 'Unknown')
            print(f"  Event Type: {event_type} (Merchant: {merchant_id})")
                
            # Trigger sync for any customer-related or booking-related data change
            is_customer_change = (
                event_type in ['customer.created', 'customer.updated'] or
                (event_type and event_type.startswith('customer.custom_attribute.')) or
                (event_type and event_type.startswith('booking.'))
            )

            if is_customer_change:
                print(f"  --> Triggering background sync_all...")
                self._run_in_background(self.engine.sync_all)
            elif event_type == 'customer.deleted':
                customer_id = (payload.get('data', {}).get('object', {}).get('customer', {}).get('id') or
                               payload.get('data', {}).get('id'))
                if customer_id:
                    print(f"  --> Triggering background deletion for: {customer_id}")
                    self._run_in_background(self.engine.handle_square_deletion, customer_id)
                else:
                    print("  --> customer.deleted received but no ID found")
            else:
                print(f"  --> Event {event_type} not handled explicitly.")
                
            return jsonify({'status': 'received'}), 200

        except Exception as e:
            print(f"  ❌ Error in handle_square: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({'status': 'error', 'message': str(e)}), 500

    def _check_ops_api_key(self) -> bool:
        """Validate optional API key for operations contact exchange."""
        expected = os.getenv('CONTACT_SYNC_API_KEY', '').strip()
        if not expected:
            return True
        received = request.headers.get('X-API-Key', '').strip()
        return received == expected

    def handle_ops_contact_sync(self):
        """Operations portal -> contact sync exchange endpoint."""
        if not self._check_ops_api_key():
            return jsonify({'error': 'unauthorized'}), 401

        payload = request.get_json(silent=True) or {}
        action = str(payload.get('action', 'upsert')).lower().strip()

        try:
            if action == 'delete':
                result = self.engine.delete_contact_from_operations(payload)
                status = 404 if result.get('status') == 'not_found' else 200
                return jsonify(result), status

            result = self.engine.upsert_contact_from_operations(payload)
            return jsonify(result), 200
        except ValueError as e:
            return jsonify({'error': 'bad_request', 'message': str(e)}), 400
        except Exception as e:
            print(f"[OPS-CONTACT] Error: {e}")
            return jsonify({'error': 'sync_failed', 'message': str(e)}), 500

    def _run_in_background(self, func, *args):
        """Helper to run task in daemon thread without blocking the response."""
        import threading
        def wrapper():
            try:
                func(*args)
            except Exception as e:
                print(f"\n❌ [Thread-Error] Failed in {func.__name__}: {e}")
                import traceback
                traceback.print_exc()
        
        t = threading.Thread(target=wrapper, daemon=True)
        t.start()

    def _verify_square_signature(self, body, signature):
        body_str = body.decode('utf-8')
        sig_string = self.square_webhook_url + body_str
        
        hmac_obj = hmac.new(
            self.square_signature_key.encode('utf-8'),
            sig_string.encode('utf-8'),
            hashlib.sha256
        )
        
        computed_signature = hmac_obj.digest()
        import base64
        computed_b64 = base64.b64encode(computed_signature).decode('utf-8')
        
        return hmac.compare_digest(computed_b64, signature)

    def run(self, host='0.0.0.0'):
        print(f"\n[WebhookServer] Starting V2 combined listener on {host}:{self.port}")
        self.app.run(host=host, port=self.port, debug=False)
