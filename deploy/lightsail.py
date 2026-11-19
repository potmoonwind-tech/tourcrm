"""TourCRM on AWS Lightsail (eu-north-1): the container service "tourcrm", the database "tourcrm-db"
and the photos bucket. Uses the AWS CLI signed in with `aws login --profile tourcrm`. Secrets go
from AWS to the service's settings and are never printed.

    python deploy/lightsail.py setup            first deployment: settings (database, secret key, bucket) + latest image
    python deploy/lightsail.py deploy [TAG]     a new version: the image ghcr.io/potmoonwind-tech/tourcrm:TAG
                                                (default "latest"); the settings stay as they are
    python deploy/lightsail.py status           where it is and what runs
"""
import json
import os
import secrets
import shutil
import subprocess
import sys

PROFILE = os.environ.get("AWS_PROFILE", "tourcrm")
REGION = "eu-north-1"
SERVICE = "tourcrm"
DATABASE = "tourcrm-db"
IMAGE = "ghcr.io/potmoonwind-tech/tourcrm"


def aws(*args: str) -> dict:
    exe = shutil.which("aws") or os.path.expandvars(r"%LOCALAPPDATA%\Programs\Amazon\AWSCLIV2\aws.exe")
    out = subprocess.run([exe, *args, "--profile", PROFILE, "--region", REGION, "--output", "json"],
                         capture_output=True, text=True)
    if out.returncode:
        sys.exit(f"aws {args[0]} {args[1]}: {out.stderr.strip()}")
    return json.loads(out.stdout or "{}")


def service() -> dict:
    return aws("lightsail", "get-container-services", "--service-name", SERVICE)["containerServices"][0]


def deploy(containers: dict) -> None:
    endpoint = {"containerName": "app", "containerPort": 8000,
                "healthCheck": {"path": "/health", "intervalSeconds": 30, "timeoutSeconds": 5, "healthyThreshold": 2, "unhealthyThreshold": 4}}
    aws("lightsail", "create-container-service-deployment", "--service-name", SERVICE,
        "--containers", json.dumps(containers), "--public-endpoint", json.dumps(endpoint))
    print(f"Deploying {containers['app']['image']} - Lightsail switches over once it answers /health (a few minutes).")


def setup() -> None:
    db = aws("lightsail", "get-relational-database", "--relational-database-name", DATABASE)["relationalDatabase"]
    if db["state"] != "available":
        sys.exit(f"The database is {db['state']} - try again when it is available.")
    password = aws("lightsail", "get-relational-database-master-user-password",
                   "--relational-database-name", DATABASE)["masterUserPassword"]
    host, port = db["masterEndpoint"]["address"], db["masterEndpoint"]["port"]
    bucket = next(b["name"] for b in aws("lightsail", "get-buckets")["buckets"] if b["name"].startswith("tourcrm-files-"))
    key = aws("lightsail", "create-bucket-access-key", "--bucket-name", bucket)["accessKey"]
    aws("lightsail", "update-bucket", "--bucket-name", bucket, "--access-rules", json.dumps({"getObject": "private", "allowPublicOverrides": False}))
    url = service()["url"].rstrip("/")
    env = {
        "DATABASE_URL": f"postgresql://{db['masterUsername']}:{password}@{host}:{port}/{db['masterDatabaseName']}?sslmode=require",
        "SECRET_KEY": secrets.token_urlsafe(48),
        "APP_URL": url,
        "PORT": "8000",
        "S3_BUCKET": bucket,
        "S3_REGION": REGION,
        "AWS_ACCESS_KEY_ID": key["accessKeyId"],
        "AWS_SECRET_ACCESS_KEY": key["secretAccessKey"],
    }
    deploy({"app": {"image": f"{IMAGE}:latest", "ports": {"8000": "HTTP"}, "environment": env}})
    print(f"Site: {url}")


def new_version(tag: str) -> None:
    current = service().get("currentDeployment")
    if not current:
        sys.exit("No deployment yet: run setup first.")
    app = current["containers"]["app"]
    deploy({"app": {"image": f"{IMAGE}:{tag}", "ports": app.get("ports", {"8000": "HTTP"}), "environment": app.get("environment", {})}})


def status() -> None:
    s = service()
    cur, nxt = s.get("currentDeployment") or {}, s.get("nextDeployment") or {}
    print(f"{s['containerServiceName']}: {s['state']} · {s['power']} x{s['scale']} · {s['url']}")
    if cur:
        print(f"  running: {cur['containers']['app']['image']} ({cur['state']})")
    if nxt:
        print(f"  next:    {nxt['containers']['app']['image']} ({nxt['state']})")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "status"
    if what == "setup":
        setup()
    elif what == "deploy":
        new_version(sys.argv[2] if len(sys.argv) > 2 else "latest")
    else:
        status()
