import sys
import urllib.request
import json

def test_ping():
    print("=== Media Fetch Connection Test ===")
    
    # Try different ports to find the active server
    ports = [8000, 8001, 8002, 8003, 8004, 8005]
    active_url = None
    
    for port in ports:
        url = f"http://localhost:{port}/api/health"
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=1.5) as response:
                if response.status == 200:
                    data = json.loads(response.read().decode("utf-8"))
                    if data.get("status") == "ok":
                        active_url = f"http://localhost:{port}"
                        print(f"[✓] Active backend detected at: {active_url}")
                        print(f"    - Version: {data.get('version')}")
                        print(f"    - Update Available: {data.get('update_available')}")
                        print(f"    - Latest Release: {data.get('latest_version')}")
                        break
        except Exception:
            continue
            
    if not active_url:
        print("[✗] Error: Local Media Fetch backend is offline or unreachable.")
        print("    Please run setup.sh / setup.bat first to start the server.")
        sys.exit(1)
        
    print("===================================")

if __name__ == "__main__":
    test_ping()
