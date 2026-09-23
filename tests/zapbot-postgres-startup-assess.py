#!/usr/bin/env python3
"""Assess one disposable PostgreSQL startup receipt without contacting Docker."""

import json
import re
import sys
from pathlib import Path


BOUNDARY = re.compile(
    r"PGCTL_PROBE phase=(start|stop) caller=(\d+):(\d+) "
    r"pgdata=(\d+:\d+) (\d+):(\d+) (\d+)"
)
OWNERSHIP = re.compile(
    r"^(\S+) dev:inode=(\d+:\d+) uid:gid=(\d+):(\d+) mode=(\d+)$"
)


def assess(receipt: Path, storage: str) -> dict:
    reasons: list[str] = []
    coherence_reasons: list[str] = []
    try:
        state = json.loads((receipt / "postgres-state.json").read_text())
        log = (receipt / "postgres.log").read_text()
        ownership = (receipt / "ownership.txt").read_text()
        config = json.loads((receipt / "resolved-config.json").read_text())
    except (OSError, ValueError) as exc:
        return {
            "storage": storage,
            "startup": "fail",
            "ownership_coherence": "unknown",
            "reasons": [f"incomplete or invalid receipt: {type(exc).__name__}"],
        }

    image = config.get("postgres_image", "")
    if not isinstance(image, str) or not re.search(r"@sha256:[0-9a-f]{64}$", image):
        reasons.append("PostgreSQL image is not pinned to a SHA-256 digest")
    if config.get("credential_image") != image or config.get("tls_image") != image:
        reasons.append("PostgreSQL bootstrap images differ from the pinned database image")
    if config.get("pgdata") != "/var/lib/postgresql/data/pgdata":
        reasons.append("unexpected PGDATA")
    environment = config.get("postgres_environment")
    if not isinstance(environment, dict) or environment.get("POSTGRES_PASSWORD_FILE") != "/run/zapbot-secret/password":
        reasons.append("unexpected PostgreSQL password-file configuration")
    postgres_mounts = config.get("postgres_mounts")
    credential_mounts = config.get("credential_mounts")
    credential_target = "/data" if storage == "bind" else "/data/postgres"
    postgres_data = [mount for mount in postgres_mounts if mount.get("target") == "/var/lib/postgresql/data"] if isinstance(postgres_mounts, list) else []
    credential_data = [mount for mount in credential_mounts if mount.get("target") == credential_target] if isinstance(credential_mounts, list) else []
    if len(postgres_data) != 1 or len(credential_data) != 1:
        reasons.append("expected exactly one PostgreSQL data mount in each service")
    else:
        postgres_mount = postgres_data[0]
        credential_mount = credential_data[0]
        postgres_source = postgres_mount.get("source")
        credential_source = credential_mount.get("source")
        if storage == "bind":
            if postgres_mount.get("type") != "bind" or credential_mount.get("type") != "bind":
                reasons.append("bind probe resolved to a non-bind data mount")
            if not isinstance(credential_source, str) or not Path(credential_source).is_absolute() or postgres_source != str(Path(credential_source) / "postgres"):
                reasons.append("bind data mount is not the credential data parent's postgres child")
        elif storage == "named":
            project = config.get("project")
            if postgres_mount.get("type") != "volume" or credential_mount.get("type") != "volume":
                reasons.append("named probe resolved to a non-volume data mount")
            if not isinstance(project, str) or not project.startswith("zapbot-pg-probe-") or config.get("expected_named_volume") != f"{project}-pgdata":
                reasons.append("named probe has an unexpected volume name")
            if postgres_source != "pg_probe_data" or credential_source != "pg_probe_data":
                reasons.append("named probe services do not share the expected data volume")
        else:
            reasons.append("unknown storage mode")
    if state.get("health") != "healthy" or state.get("state") != "running":
        reasons.append("PostgreSQL did not finish running and healthy")
    if state.get("restart") != 0:
        reasons.append("PostgreSQL restarted during the probe")
    if re.search(r"\bFATAL:|pg_ctl: could not start server", log, re.IGNORECASE):
        reasons.append("initial PostgreSQL fatal or pg_ctl startup failure")

    boundaries = [match.groups() for match in BOUNDARY.finditer(log)]
    phases = [item[0] for item in boundaries]
    if phases.count("start") != 1 or phases.count("stop") != 1 or len(phases) != 2:
        reasons.append("expected exactly one instrumented pg_ctl start and stop")
    for phase, caller_uid, caller_gid, inode, owner_uid, owner_gid, mode in boundaries:
        if caller_uid != "999" or caller_gid != "999" or owner_uid != "999":
            reasons.append(f"pg_ctl {phase} did not observe the UID 999 ownership boundary")
        if mode != "700":
            reasons.append(f"pg_ctl {phase} observed unexpected PGDATA mode")
    boundary_inodes = {item[3] for item in boundaries}
    if len(boundary_inodes) != 1:
        reasons.append("PGDATA inode changed across pg_ctl boundaries")

    section = ""
    views: dict[str, tuple[str, str]] = {}
    for line in ownership.splitlines():
        if line.startswith("view="):
            section = line.split()[0].removeprefix("view=")
        elif line.startswith("actual_postgres_container caller="):
            section = "actual_" + line.split()[1].split("=", 1)[1]
        else:
            match = OWNERSHIP.match(line)
            if not match:
                continue
            path, inode, uid, gid, mode = match.groups()
            expected_path = {
                "credential_after": "/data/postgres",
                "postgres_before": "/var/lib/postgresql/data",
                "credential_final": "/data/postgres/pgdata",
                "postgres_final": "/var/lib/postgresql/data/pgdata",
                "actual_0:0": "/var/lib/postgresql/data/pgdata",
                "actual_999:999": "/var/lib/postgresql/data/pgdata",
            }.get(section)
            if path == expected_path:
                views[section] = (inode, uid)

    prestart = ("credential_after", "postgres_before")
    for required in prestart:
        if required not in views:
            coherence_reasons.append(f"missing pre-start data-parent observation from {required}")
        elif views[required][1] != "999":
            coherence_reasons.append(f"pre-start data-parent owner UID is {views[required][1]} in {required}")
    if all(required in views for required in prestart) and views[prestart[0]][0] != views[prestart[1]][0]:
        coherence_reasons.append("pre-start data-parent inode differs across credential and PostgreSQL mounts")

    for required in ("credential_final", "postgres_final", "actual_0:0", "actual_999:999"):
        if required not in views:
            coherence_reasons.append(f"missing PGDATA observation from {required}")
            continue
        inode, uid = views[required]
        if len(boundary_inodes) != 1 or inode not in boundary_inodes:
            coherence_reasons.append(f"PGDATA inode differs in {required}")
        if uid != "999":
            coherence_reasons.append(f"PGDATA owner UID is {uid} in {required}")

    return {
        "storage": storage,
        "startup": "pass" if not reasons else "fail",
        "ownership_coherence": "pass" if not coherence_reasons else "fail",
        "reasons": reasons + coherence_reasons,
    }


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in {"bind", "named"}:
        print("usage: zapbot-postgres-startup-assess.py RECEIPT_DIR bind|named", file=sys.stderr)
        return 64
    receipt = Path(sys.argv[1])
    result = assess(receipt, sys.argv[2])
    (receipt / "assessment.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"startup={result['startup']} ownership_coherence={result['ownership_coherence']} storage={result['storage']}")
    for reason in result["reasons"]:
        print(f"reason={reason}")
    return 0 if result["startup"] == result["ownership_coherence"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
