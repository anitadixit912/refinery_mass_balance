#!/usr/bin/env python3
"""
Fetches the 'aicore' BTP destination and writes credentials to .env.local.
Run from the refinery-mass-balance directory after `cf login`.

Usage:
  python3 scripts/fetch-aicore-creds.py
"""

import json, os, re, subprocess, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_LOCAL = os.path.join(ROOT, '.env.local')

# ── 1. Get VCAP_SERVICES from the aicore-api-gateway CF app ──────────────────
print("Reading CF environment from aicore-api-gateway...")
result = subprocess.run(
    ["cf", "env", "aicore-api-gateway"],
    capture_output=True, text=True
)
if result.returncode != 0:
    print("ERROR: cf env failed —", result.stderr.strip())
    print("Make sure you are logged in: cf login -a https://api.cf.us10.hana.ondemand.com")
    raise SystemExit(1)

raw = result.stdout
# Extract the VCAP_SERVICES JSON block
m = re.search(r'VCAP_SERVICES:\s*(\{.*?\})\s*\n\n', raw, re.DOTALL)
if not m:
    print("ERROR: Could not parse VCAP_SERVICES from cf env output")
    raise SystemExit(1)

vcap = json.loads(m.group(1))
dest_binding = vcap.get("destination", [{}])[0].get("credentials", {})

dest_client_id     = dest_binding["clientid"]
dest_client_secret = dest_binding["clientsecret"]
dest_token_url     = dest_binding["url"]      # XSUAA token endpoint
dest_service_url   = dest_binding["uri"]      # Destination service REST base

# ── 2. Get OAuth2 token for the Destination Service ───────────────────────────
print("Getting Destination Service token...")
token_data = urllib.parse.urlencode({
    "grant_type"   : "client_credentials",
    "client_id"    : dest_client_id,
    "client_secret": dest_client_secret,
}).encode()

req = urllib.request.Request(
    f"{dest_token_url}/oauth/token",
    data=token_data,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST",
)
with urllib.request.urlopen(req) as resp:
    token_json = json.load(resp)

access_token = token_json.get("access_token")
if not access_token:
    print("ERROR: No access_token returned:", token_json)
    raise SystemExit(1)
print("Token obtained.")

# ── 3. Fetch the 'aicore' destination ────────────────────────────────────────
print("Fetching 'aicore' destination...")
dest_req = urllib.request.Request(
    f"{dest_service_url}/destination-configuration/v1/destinations/aicore",
    headers={"Authorization": f"Bearer {access_token}"},
    method="GET",
)
with urllib.request.urlopen(dest_req) as resp:
    dest_data = json.load(resp)

cfg = dest_data.get("destinationConfiguration", {})

url        = cfg.get("URL", "")
client_id  = cfg.get("clientId",       cfg.get("Client_Id",     ""))
secret     = cfg.get("clientSecret",   cfg.get("Client_Secret", ""))
token_url  = cfg.get("tokenServiceURL",cfg.get("TokenServiceURL",""))

# API base URL = everything before /v2/... in the URL
api_url = re.match(r"(https://[^/]+)", url).group(1) if url else ""

# Deployment ID = last path segment if URL contains /deployments/
depl_id = ""
if "/deployments/" in url:
    depl_id = url.rstrip("/").split("/deployments/")[-1].split("/")[0]

resource_group = cfg.get("resourceGroup", cfg.get("AI-Resource-Group", "default"))

# ── 4. Print non-secret summary ──────────────────────────────────────────────
print("\n=== aicore destination ===")
print(f"  URL             : {url}")
print(f"  API URL         : {api_url}")
print(f"  Token URL       : {token_url}")
print(f"  Client ID       : {client_id[:40]}..." if len(client_id) > 40 else f"  Client ID       : {client_id}")
print(f"  Client Secret   : {'***SET***' if secret else '(empty)'}")
print(f"  Deployment ID   : {depl_id or '(not in URL — check below)'}")
print(f"  Resource Group  : {resource_group}")
print()

if not secret:
    print("WARNING: clientSecret was empty in the destination.")
    print("         You may need to set it manually in .env.local")

# ── 5. Write to .env.local ────────────────────────────────────────────────────
with open(ENV_LOCAL, "r") as f:
    lines = f.read().splitlines()

updates = {
    "AICORE_CLIENT_ID"     : client_id      if client_id  else None,
    "AICORE_CLIENT_SECRET" : secret         if secret     else None,
    "AICORE_TOKEN_URL"     : token_url      if token_url  else None,
    "AICORE_API_URL"       : api_url        if api_url    else None,
    "AICORE_DEPLOYMENT_ID" : depl_id        if depl_id    else None,
    "AICORE_RESOURCE_GROUP": resource_group if resource_group else None,
}

new_lines = []
for line in lines:
    replaced = False
    for key, val in updates.items():
        if line.startswith(f"{key}=") and val:
            new_lines.append(f"{key}={val}")
            replaced = True
            break
    if not replaced:
        new_lines.append(line)

with open(ENV_LOCAL, "w") as f:
    f.write("\n".join(new_lines) + "\n")

print(f".env.local updated at: {ENV_LOCAL}")
print("\nNext step: docker compose up -d --force-recreate")
