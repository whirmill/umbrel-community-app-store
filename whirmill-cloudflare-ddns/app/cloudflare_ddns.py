#!/usr/bin/env python3
"""Small, dependency-free Cloudflare IPv4 DDNS service for Umbrel."""

from __future__ import annotations

import ipaddress
import json
import mimetypes
import os
import re
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable


API_BASE = "https://api.cloudflare.com/client/v4"
TRACE_ENDPOINTS = (
    "https://api.cloudflare.com/cdn-cgi/trace",
    "https://www.cloudflare.com/cdn-cgi/trace",
    "https://connectivity.cloudflareclient.com/cdn-cgi/trace",
)
DEFAULT_ZONE = "satssurge.com"
DEFAULT_RECORDS = (
    "smp.satssurge.com",
    "xftp.satssurge.com",
    "turn.satssurge.com",
)
DEFAULT_INTERVAL = 300
MAX_RESPONSE_BYTES = 1_048_576
MAX_REQUEST_BYTES = 65_536
TOKEN_RE = re.compile(r"^[A-Za-z0-9._~-]{20,512}$")
LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class DDNSError(RuntimeError):
    """Expected, user-facing DDNS error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_dns_name(value: Any) -> str:
    if not isinstance(value, str):
        raise DDNSError("Il nome DNS deve essere una stringa.")
    candidate = value.strip().rstrip(".").lower()
    if not candidate or "*" in candidate:
        raise DDNSError("Il nome DNS non è valido.")
    try:
        ascii_name = candidate.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise DDNSError("Il nome DNS non è valido.") from exc
    if len(ascii_name) > 253:
        raise DDNSError("Il nome DNS è troppo lungo.")
    labels = ascii_name.split(".")
    if len(labels) < 2 or any(not LABEL_RE.fullmatch(label) for label in labels):
        raise DDNSError("Il nome DNS non è valido.")
    return ascii_name


def validate_config(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise DDNSError("La configurazione deve essere un oggetto JSON.")

    if "api_token" in payload:
        raise DDNSError("Il token API non può essere inviato via HTTP.")

    zone = normalize_dns_name(payload.get("zone", DEFAULT_ZONE))
    raw_records = payload.get("records", list(DEFAULT_RECORDS))
    if not isinstance(raw_records, list) or not 1 <= len(raw_records) <= 20:
        raise DDNSError("Configura da 1 a 20 record DNS.")

    records: list[str] = []
    for raw_record in raw_records:
        record = normalize_dns_name(raw_record)
        if record != zone and not record.endswith(f".{zone}"):
            raise DDNSError(f"Il record {record} non appartiene alla zona {zone}.")
        if record not in records:
            records.append(record)
    if not records:
        raise DDNSError("Configura almeno un record DNS.")

    interval = payload.get("interval_seconds", DEFAULT_INTERVAL)
    if isinstance(interval, bool) or not isinstance(interval, int) or not 60 <= interval <= 86_400:
        raise DDNSError("L'intervallo deve essere compreso tra 60 e 86400 secondi.")

    return {
        "zone": zone,
        "records": records,
        "interval_seconds": interval,
    }


def read_api_token(path: Path) -> str:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError as exc:
        raise DDNSError("Installa prima il token Cloudflare tramite SSH.") from exc
    except OSError as exc:
        raise DDNSError("Il file del token Cloudflare non è leggibile in sicurezza.") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise DDNSError("Il file del token deve essere regolare e avere permessi 0600.")
        with os.fdopen(descriptor, "r", encoding="ascii", closefd=False) as handle:
            token = handle.read(513)
    except (OSError, UnicodeError) as exc:
        raise DDNSError("Il file del token Cloudflare non è valido.") from exc
    finally:
        os.close(descriptor)
    if not TOKEN_RE.fullmatch(token):
        raise DDNSError("Il token API Cloudflare non è valido.")
    return token


def parse_trace(body: bytes, expected_host: str) -> str:
    if len(body) > 4096:
        raise DDNSError("La risposta del rilevatore IP è troppo grande.")
    try:
        text = body.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise DDNSError("La risposta del rilevatore IP non è valida.") from exc
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        fields[key.strip()] = value.strip()
    if fields.get("h", "").lower() != expected_host.lower():
        raise DDNSError("Il rilevatore IP ha restituito un host inatteso.")
    if fields.get("warp", "").lower() != "off":
        raise DDNSError("Rilevamento IP non affidabile: lo stato Cloudflare WARP non è off.")
    raw_ip = fields.get("ip", "")
    try:
        address = ipaddress.ip_address(raw_ip)
    except ValueError as exc:
        raise DDNSError("Il rilevatore non ha restituito un IPv4 valido.") from exc
    if address.version != 4 or not address.is_global:
        raise DDNSError("L'indirizzo rilevato non è un IPv4 pubblico.")
    return str(address)


def detect_public_ipv4(
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> str:
    last_error: Exception | None = None
    for endpoint in TRACE_ENDPOINTS:
        request = urllib.request.Request(
            endpoint,
            headers={"User-Agent": "Umbrel-Cloudflare-DDNS/1.0"},
        )
        try:
            with opener(request, timeout=10) as response:
                body = response.read(4097)
            expected_host = urllib.parse.urlsplit(endpoint).hostname or ""
            return parse_trace(body, expected_host)
        except (DDNSError, OSError, urllib.error.URLError) as exc:
            last_error = exc
    raise DDNSError("Impossibile rilevare l'IPv4 pubblico via HTTPS.") from last_error


class CloudflareClient:
    def __init__(
        self,
        token: str,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self._token = token
        self._opener = opener

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{API_BASE}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        encoded = None
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
            "User-Agent": "Umbrel-Cloudflare-DDNS/1.0",
        }
        if body is not None:
            encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=encoded, headers=headers, method=method)
        try:
            with self._opener(request, timeout=15) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            if exc.code == HTTPStatus.TOO_MANY_REQUESTS:
                raise DDNSError("Cloudflare ha applicato un limite temporaneo; riprova più tardi.") from exc
            raise DDNSError(f"Cloudflare ha rifiutato la richiesta (HTTP {exc.code}).") from exc
        except (OSError, urllib.error.URLError) as exc:
            raise DDNSError("Cloudflare non è raggiungibile.") from exc
        if len(raw) > MAX_RESPONSE_BYTES:
            raise DDNSError("La risposta Cloudflare è troppo grande.")
        try:
            envelope = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DDNSError("Cloudflare ha restituito una risposta non valida.") from exc
        if not isinstance(envelope, dict) or envelope.get("success") is not True:
            errors = envelope.get("errors", []) if isinstance(envelope, dict) else []
            code = None
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                code = errors[0].get("code")
            suffix = f" (codice {code})" if isinstance(code, int) else ""
            raise DDNSError(f"Richiesta Cloudflare non riuscita{suffix}.")
        return envelope

    def verify_token(self) -> None:
        envelope = self._request("GET", "/user/tokens/verify")
        result = envelope.get("result")
        if not isinstance(result, dict) or result.get("status") != "active":
            raise DDNSError("Il token API Cloudflare non è attivo.")

    def find_zone(self, name: str) -> str:
        envelope = self._request(
            "GET",
            "/zones",
            query={"name": name, "status": "active", "page": 1, "per_page": 2},
        )
        result = envelope.get("result")
        matches = [
            item
            for item in result if isinstance(item, dict) and item.get("name", "").lower() == name
        ] if isinstance(result, list) else []
        if len(matches) != 1 or not isinstance(matches[0].get("id"), str):
            raise DDNSError(f"Zona Cloudflare attiva non trovata in modo univoco: {name}.")
        return matches[0]["id"]

    def find_a_record(self, zone_id: str, name: str) -> dict[str, Any]:
        envelope = self._request(
            "GET",
            f"/zones/{urllib.parse.quote(zone_id, safe='')}/dns_records",
            query={"type": "A", "name": name, "page": 1, "per_page": 100},
        )
        result = envelope.get("result")
        matches = [
            item
            for item in result
            if isinstance(item, dict)
            and item.get("type") == "A"
            and item.get("name", "").lower().rstrip(".") == name
        ] if isinstance(result, list) else []
        if len(matches) != 1:
            raise DDNSError(f"Il record A {name} non esiste o non è univoco.")
        record = matches[0]
        if not isinstance(record.get("id"), str):
            raise DDNSError(f"Il record A {name} non ha un identificatore valido.")
        return record

    def update_a_record(self, zone_id: str, record: dict[str, Any], ip: str) -> None:
        ttl = record.get("ttl", 1)
        if isinstance(ttl, bool) or not isinstance(ttl, int) or ttl < 1:
            ttl = 1
        record_id = urllib.parse.quote(record["id"], safe="")
        self._request(
            "PATCH",
            f"/zones/{urllib.parse.quote(zone_id, safe='')}/dns_records/{record_id}",
            body={
                "type": "A",
                "name": record["name"],
                "content": ip,
                "ttl": ttl,
                "proxied": False,
            },
        )


@dataclass(frozen=True)
class UpdateResult:
    ip: str
    updated: tuple[str, ...]
    unchanged: tuple[str, ...]


def validate_cloudflare_config(config: dict[str, Any], token: str) -> None:
    client = CloudflareClient(token)
    client.verify_token()
    zone_id = client.find_zone(config["zone"])
    for record_name in config["records"]:
        client.find_a_record(zone_id, record_name)


def perform_update(
    config: dict[str, Any],
    *,
    token: str,
    client_factory: Callable[[str], CloudflareClient] = CloudflareClient,
    ip_detector: Callable[[], str] = detect_public_ipv4,
) -> UpdateResult:
    ip = ip_detector()
    client = client_factory(token)
    zone_id = client.find_zone(config["zone"])
    records = [(name, client.find_a_record(zone_id, name)) for name in config["records"]]

    updated: list[str] = []
    unchanged: list[str] = []
    for name, record in records:
        if record.get("content") == ip and record.get("proxied") is False:
            unchanged.append(name)
            continue
        client.update_a_record(zone_id, record, ip)
        updated.append(name)
    return UpdateResult(ip=ip, updated=tuple(updated), unchanged=tuple(unchanged))


class DDNSService:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.config_path = data_dir / "config.json"
        self.token_path = data_dir / "api-token"
        self.status_path = data_dir / "status.json"
        self.lock = threading.RLock()
        self.update_lock = threading.Lock()
        self.wake = threading.Event()
        self.stop = threading.Event()
        self.config = self._load_config()
        self.status: dict[str, Any] = {
            "running": False,
            "last_attempt": None,
            "last_success": None,
            "current_ip": None,
            "last_result": None,
            "error": None,
        }
        self.worker = threading.Thread(target=self._loop, name="ddns-worker", daemon=True)

    def _load_config(self) -> dict[str, Any] | None:
        try:
            raw = json.loads(self.config_path.read_text(encoding="utf-8"))
            return validate_config(raw)
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError, DDNSError):
            return None

    def start(self) -> None:
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            os.chmod(self.data_dir, 0o700)
        except OSError:
            pass
        self.worker.start()
        if self.config:
            self.wake.set()

    def shutdown(self) -> None:
        self.stop.set()
        self.wake.set()
        self.worker.join(timeout=5)

    def public_status(self) -> dict[str, Any]:
        with self.lock:
            config = self.config
            return {
                "configured": config is not None,
                "token_configured": self._token_is_available(),
                "zone": config["zone"] if config else DEFAULT_ZONE,
                "records": list(config["records"] if config else DEFAULT_RECORDS),
                "interval_seconds": config["interval_seconds"] if config else DEFAULT_INTERVAL,
                **self.status,
            }

    def _token_is_available(self) -> bool:
        try:
            read_api_token(self.token_path)
        except DDNSError:
            return False
        return True

    def save_config(self, config: dict[str, Any]) -> None:
        with self.update_lock:
            self._save_config_locked(config)
        self._write_status()
        self.wake.set()

    def validate_and_save_config(self, config: dict[str, Any]) -> None:
        with self.update_lock:
            token = read_api_token(self.token_path)
            validate_cloudflare_config(config, token)
            self._save_config_locked(config)
        self._write_status()
        self.wake.set()

    def _save_config_locked(self, config: dict[str, Any]) -> None:
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="config.", dir=self.data_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(config, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary_name, 0o600)
            os.replace(temporary_name, self.config_path)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
        with self.lock:
            self.config = config
            self.status["error"] = None
            self.status["last_result"] = "Configurazione verificata e salvata."

    def remove_config(self) -> None:
        with self.update_lock:
            with self.lock:
                self.config = None
                self.status = {
                    "running": False,
                    "last_attempt": None,
                    "last_success": None,
                    "current_ip": None,
                    "last_result": "Configurazione e token rimossi.",
                    "error": None,
                }
            for path in (self.config_path, self.token_path):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        self._write_status()
        self.wake.set()

    def trigger(self) -> bool:
        with self.lock:
            if self.config is None or self.status["running"]:
                return False
        self.wake.set()
        return True

    def _write_status(self) -> None:
        safe_status = self.public_status()
        try:
            fd, temporary_name = tempfile.mkstemp(prefix="status.", dir=self.data_dir)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(safe_status, handle, separators=(",", ":"))
                os.chmod(temporary_name, 0o600)
                os.replace(temporary_name, self.status_path)
            finally:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
        except OSError:
            pass

    def _run_once(self) -> None:
        with self.update_lock:
            with self.lock:
                if self.config is None or self.status["running"]:
                    return
                config = dict(self.config)
                config["records"] = list(self.config["records"])
                self.status["running"] = True
                self.status["last_attempt"] = utc_now()
                self.status["error"] = None
            self._write_status()
            try:
                token = read_api_token(self.token_path)
                result = perform_update(config, token=token)
            except DDNSError as exc:
                with self.lock:
                    self.status["error"] = str(exc)
                    self.status["last_result"] = "Aggiornamento non riuscito."
            except Exception:
                with self.lock:
                    self.status["error"] = "Errore interno durante l'aggiornamento."
                    self.status["last_result"] = "Aggiornamento non riuscito."
            else:
                with self.lock:
                    self.status["current_ip"] = result.ip
                    self.status["last_success"] = utc_now()
                    self.status["last_result"] = (
                        f"Aggiornati {len(result.updated)} record; "
                        f"già corretti {len(result.unchanged)}."
                    )
                    self.status["error"] = None
            finally:
                with self.lock:
                    self.status["running"] = False
                self._write_status()

    def _loop(self) -> None:
        next_wait = 60
        while not self.stop.is_set():
            signalled = self.wake.wait(timeout=next_wait)
            self.wake.clear()
            if self.stop.is_set():
                break
            with self.lock:
                config = self.config
            if config is None:
                next_wait = 60
                continue
            if signalled or not self.status["last_attempt"]:
                self._run_once()
            else:
                self._run_once()
            with self.lock:
                next_wait = self.config["interval_seconds"] if self.config else 60


class DDNSHandler(BaseHTTPRequestHandler):
    service: DDNSService
    web_dir: Path
    server_version = "UmbrelCloudflareDDNS/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        # Request bodies and headers are intentionally never logged.
        print(f"http {self.command} {self.path.split('?', 1)[0]} {args[1] if len(args) > 1 else '-'}", flush=True)

    def _security_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._security_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _read_json(self) -> Any:
        if self.headers.get_content_type() != "application/json":
            raise DDNSError("Content-Type deve essere application/json.")
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "")
        except ValueError as exc:
            raise DDNSError("Content-Length non valido.") from exc
        if not 1 <= length <= MAX_REQUEST_BYTES:
            raise DDNSError("Corpo della richiesta assente o troppo grande.")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DDNSError("JSON non valido.") from exc

    def _require_action_header(self) -> None:
        if self.headers.get("X-Requested-With") != "cloudflare-ddns":
            raise DDNSError("Header di sicurezza mancante.")

    def do_GET(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/api/status":
            self._send_json(HTTPStatus.OK, self.service.public_status())
            return
        self._serve_static(path)

    def do_POST(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        try:
            self._require_action_header()
            if path == "/api/config":
                config = validate_config(self._read_json())
                self.service.validate_and_save_config(config)
                self._send_json(HTTPStatus.OK, {"ok": True, "status": self.service.public_status()})
                return
            if path == "/api/run":
                if not self.service.public_status()["configured"]:
                    raise DDNSError("Configura prima l'updater.")
                accepted = self.service.trigger()
                self._send_json(HTTPStatus.ACCEPTED, {"ok": True, "accepted": accepted})
                return
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Endpoint non trovato."})
        except DDNSError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

    def do_DELETE(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        try:
            self._require_action_header()
            if path != "/api/config":
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Endpoint non trovato."})
                return
            self.service.remove_config()
            self._send_json(HTTPStatus.OK, {"ok": True, "status": self.service.public_status()})
        except DDNSError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})

    def do_OPTIONS(self) -> None:
        self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "Metodo non consentito."})

    def _serve_static(self, path: str) -> None:
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        allowed = {"index.html", "app.js", "styles.css"}
        if relative not in allowed:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Risorsa non trovata."})
            return
        target = self.web_dir / relative
        try:
            content = target.read_bytes()
        except OSError:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Risorsa non trovata."})
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self._security_headers()
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    data_dir = Path(os.environ.get("DATA_DIR", "/data"))
    web_dir = Path(os.environ.get("WEB_DIR", "/web"))
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8080"))
    service = DDNSService(data_dir)
    service.start()
    DDNSHandler.service = service
    DDNSHandler.web_dir = web_dir
    server = ThreadingHTTPServer((host, port), DDNSHandler)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        service.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
