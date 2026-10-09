#!/usr/bin/env python3
"""
Lists AI Core deployments and writes the first running one to .env.local.

Usage:
  python3 scripts/find-aicore-deployment.py
"""

import json, os, re, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_LOCAL = os.path.join(ROOT, '.env.local')

# ── Read credentials from .env.local ─────────────────────────────────────────
creds = {}
with open(ENV_LOCAL) as f:
    for line in f:
        line = line.strip()
        if '=' in line and not line.startswith('#'):
            k, _, v = line.partition('=')
            creds[k.strip()] = v.strip()

client_id     = creds.get('AICORE_CLIENT_ID', '')
client_secret = creds.get('AICORE_CLIENT_SECRET', '')
token_url     = creds.get('AICORE_TOKEN_URL', '')
api_url       = creds.get('AICORE_API_URL', '').rstrip('/')
resource_group= creds.get('AICORE_RESOURCE_GROUP', 'default')

if not client_secret or client_secret.startswith('REPLACE'):
    print("ERROR: AICORE_CLIENT_SECRET not set in .env.local")
    raise SystemExit(1)

# ── Get AI Core OAuth2 token ──────────────────────────────────────────────────
print("Getting AI Core token...")
token_data = urllib.parse.urlencode({
    "grant_type"   : "client_credentials",
    "client_id"    : client_id,
    "client_secret": client_secret,
}).encode()

req = urllib.request.Request(
    token_url,
    data=token_data,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST",
)
with urllib.request.urlopen(req) as resp:
    token_json = json.load(resp)

access_token = token_json.get("access_token")
if not access_token:
    print("ERROR:", token_json)
    raise SystemExit(1)
print("Token obtained.")

# ── List deployments ──────────────────────────────────────────────────────────
print(f"Listing deployments (resource group: {resource_group})...")
depl_req = urllib.request.Request(
    f"{api_url}/v2/lm/deployments",
    headers={
        "Authorization"    : f"Bearer {access_token}",
        "AI-Resource-Group": resource_group,
    },
    method="GET",
)
with urllib.request.urlopen(depl_req) as resp:
    depl_data = json.load(resp)

deployments = depl_data.get("resources", depl_data if isinstance(depl_data, list) else [])

if not deployments:
    print("No deployments found. Create a deployment in AI Core Launchpad first.")
    raise SystemExit(1)

print(f"\nFound {len(deployments)} deployment(s):\n")
running = []
for d in deployments:
    depl_id    = d.get("id", "?")
    status     = d.get("status", "?")
    model      = d.get("details", {}).get("resources", {}).get("backendDetails", {}).get("model", {}).get("name", "")
    scenario   = d.get("scenarioId", "")
    exec_name  = d.get("executableId", "")
    print(f"  ID: {depl_id}  status={status}  model={model or exec_name or scenario}")
    if status == "RUNNING":
        running.append(depl_id)

if not running:
    print("\nWARNING: No RUNNING deployments found.")
    print("Start a deployment in AI Core Launchpad, then re-run this script.")
    raise SystemExit(1)

chosen = running[0]
print(f"\nUsing deployment: {chosen}")

# ── Write deployment ID to .env.local ─────────────────────────────────────────
with open(ENV_LOCAL, 'r') as f:
    lines = f.read().splitlines()

new_lines = []
for line in lines:
    if line.startswith('AICORE_DEPLOYMENT_ID='):
        new_lines.append(f'AICORE_DEPLOYMENT_ID={chosen}')
    else:
        new_lines.append(line)

with open(ENV_LOCAL, 'w') as f:
    f.write('\n'.join(new_lines) + '\n')

print(f".env.local updated: AICORE_DEPLOYMENT_ID={chosen}")
print("\nNext step: docker compose up -d --force-recreate")
