#!/usr/bin/env python3
"""Exercise the package image's native resolver behind Docker embedded DNS."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
PREFIX = "zapbot-dns-" + uuid.uuid4().hex[:10]
CONTAINERS = []
NETWORK_CREATED = False


def docker(*args, check=True, timeout=60, env=None):
    return subprocess.run(["docker", *args], text=True, capture_output=True,
                          check=check, timeout=timeout, env=env)


def cleanup():
    for container in reversed(CONTAINERS):
        docker("rm", "-f", container, check=False)
    if NETWORK_CREATED:
        docker("network", "rm", PREFIX, check=False)


def interrupted(signum, frame):
    raise SystemExit(128 + signum)


def config():
    with tempfile.TemporaryDirectory(prefix=PREFIX) as tmp:
        overlay = Path(tmp) / "proxy.yml"
        overlay.write_text('services:\n  app_proxy:\n    image: unused:test\n')
        env = dict(os.environ, APP_DATA_DIR=tmp, APP_VERSION="0.1.74",
                   APP_SEED="disposable-dns-fixture-not-a-secret")
        result = docker("compose", "--profile", "*", "-f", str(ROOT / "whirmill-zapbot/docker-compose.yml"),
                        "-f", str(overlay), "config", "--format", "json", env=env)
    services = json.loads(result.stdout)["services"]
    app = {name: value for name, value in services.items()
           if value.get("image", "").startswith("ghcr.io/whirmill/zapbot:")}
    assert len(app) == 12, f"unexpected ZapBot service coverage: {list(app)}"
    images = {value["image"] for value in app.values()}
    assert len(images) == 1
    image = images.pop()
    assert re.search(r"@sha256:[a-f0-9]{64}$", image)
    selected = {
        "whirmill-zapbot-web", "producer-lnmarkets-candles",
        "producer-coinbase-candles", "producer-lnmarkets-funding",
        "execution-coverage-acquirer",
    }
    for name, service in services.items():
        assert not service.get("dns_opt"), f"resolver deadlines changed: {name}"
        assert "ERL_INETRC" not in service.get("environment", {}), name
        if name in selected:
            assert service.get("dns") == ["9.9.9.9", "8.8.8.8"], (name, service.get("dns"))
        else:
            assert not service.get("dns"), f"DNS scope widened to {name}"
    print(f"configuration=pass selected_services={len(selected)} image={image}", flush=True)
    return image


def server(image, mode, label=None):
    label = label or mode
    name = PREFIX + "-" + label
    CONTAINERS.append(name)
    docker("run", "-d", "--name", name, "--network", PREFIX,
           "--network-alias", "fixture-" + label, "--user", "0:0",
           "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE",
           "--security-opt", "no-new-privileges", "--memory", "128m", "--pids-limit", "64",
           "-e", "ERL_FLAGS=+S 1:1 +A 1 -boot /app/releases/0.1.0/start_clean -boot_var RELEASE_LIB /app/lib", "-e", "ERL_LIBS=/app/lib", "-e", "DNS_FIXTURE_MODE=" + mode,
           "-v", str(ROOT / "tests/zapbot-dns-fixture.exs") + ":/fixture.exs:ro",
           "--entrypoint", "/app/releases/0.1.0/elixir", image, "/fixture.exs")
    for _ in range(50):
        if "dns_fixture_ready" in docker("logs", name).stdout:
            break
        time.sleep(0.1)
    else:
        raise AssertionError(docker("logs", name).stdout + docker("logs", name).stderr)
    return docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name).stdout.strip()


def client(image, options, upstreams, hostname, expected, resolver="getent", bound=20, connect_timeout=5000):
    name = PREFIX + "-client-" + uuid.uuid4().hex[:8]
    CONTAINERS.append(name)
    args = ["run", "--rm", "--name", name, "--network", PREFIX,
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "128m", "--pids-limit", "64", "-e", "ERL_FLAGS=+S 1:1 +A 1 -boot /app/releases/0.1.0/start_clean -boot_var RELEASE_LIB /app/lib", "-e", "ERL_LIBS=/app/lib"]
    for upstream in upstreams:
        args += ["--dns", upstream]
    for option in options:
        args += ["--dns-option", option]
    if resolver == "getent":
        args += ["--entrypoint", "/bin/sh", image, "-ec",
                 'cat /etc/resolv.conf; getent hosts "$1"', "fixture", hostname]
    elif resolver == "req":
        args += ["--entrypoint", "/app/releases/0.1.0/elixir", image, "-e",
                 '{:ok, _} = Application.ensure_all_started(:req); '
                 'IO.inspect(:inet_db.res_option(:timeout), label: "resolver_timeout"); '
                 'IO.puts(File.read!("/etc/resolv.conf")); '
                 'result = Req.get("http://" <> hd(System.argv()) <> ":8080", retry: false, '
                 'receive_timeout: 15000, pool_timeout: 5000, '
                 f'connect_options: [timeout: {connect_timeout}, protocols: [:http1]]); '
                 'IO.inspect(result); if not match?({:ok, %{status: 200, body: "ok"}}, result), do: System.halt(1)', hostname]
    else:
        args += ["--entrypoint", "/app/releases/0.1.0/elixir", image, "-e",
                 'IO.puts(File.read!("/etc/resolv.conf")); '
                 'IO.inspect(:inet_db.res_option(:timeout), label: "resolver_timeout"); '
                 'result = :inet.getaddr(String.to_charlist(hd(System.argv())), :inet); '
                 'IO.inspect(result); if not match?({:ok, _}, result), do: System.halt(1)', hostname]
    started = time.monotonic()
    result = docker(*args, check=False, timeout=bound)
    elapsed = time.monotonic() - started
    assert "nameserver 127.0.0.11" in result.stdout, result.stdout
    assert all(option in result.stdout for option in options), result.stdout
    if resolver in ("beam", "req"):
        assert "resolver_timeout: 2000" in result.stdout, result.stdout
    print(f"probe resolver={resolver} elapsed={elapsed:.3f}s exit={result.returncode}", flush=True)
    assert result.returncode == (0 if expected else 1), (hostname, options, result.stdout, result.stderr)
    if not expected:
        if resolver == "beam":
            assert any(error in result.stdout for error in ("{:error, :nxdomain}", "{:error, :timeout}")), result.stdout
        elif resolver == "req":
            assert "%Req.TransportError{reason:" in result.stdout, result.stdout
            assert any(error in result.stdout for error in (":nxdomain", ":timeout")), result.stdout
    if expected and hostname.endswith(".invalid") and resolver != "req":
        assert "192.0.2.123" in result.stdout or "{192, 0, 2, 123}" in result.stdout, result.stdout
    print(f"resolver={resolver} host={hostname} options={options} expected_success={expected} elapsed={elapsed:.3f}s pass", flush=True)


def same_process_recovery(image, upstreams):
    name = PREFIX + "-recovery"
    CONTAINERS.append(name)
    args = ["run", "--rm", "--name", name, "--network", PREFIX,
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--memory", "128m", "--pids-limit", "64",
            "-e", "ERL_FLAGS=+S 1:1 +A 1 -boot /app/releases/0.1.0/start_clean -boot_var RELEASE_LIB /app/lib",
            "-e", "ERL_LIBS=/app/lib", "--dns-option", "timeout:2",
            "-v", str(ROOT / "tests/zapbot-dns-recovery.exs") + ":/recovery.exs:ro"]
    for upstream in upstreams:
        args += ["--dns", upstream]
    args += ["--entrypoint", "/app/releases/0.1.0/elixir", image, "/recovery.exs", *upstreams]
    result = docker(*args, check=False, timeout=30)
    print(result.stdout, end="", flush=True)
    assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
    assert "same_process_outage=pass" in result.stdout
    assert "same_process_recovery=pass" in result.stdout


def main():
    global NETWORK_CREATED
    image = config()
    docker("image", "inspect", image)
    docker("network", "create", PREFIX)
    NETWORK_CREATED = True
    silent = server(image, "drop")
    answering = server(image, "answer")
    secondary = server(image, "answer", "answer2")
    # Simulate the production host's inherited timeout and upstream order without
    # changing this machine's Docker daemon. Selected public resolver addresses
    # are replaced by two local responsive fixtures; no public DNS is contacted.
    options = ["timeout:2"]
    selected = [answering, secondary]
    for resolver in ("beam", "req"):
        prefix = "http-" if resolver == "req" else ""
        client(image, options, [silent, answering], prefix + "old-order.invalid", False, resolver)
        client(image, options, selected, prefix + "selected.invalid", True, resolver, bound=10)
        client(image, options, [silent], prefix + "outage.invalid", False, resolver)
        client(image, options, selected, prefix + "recovered.invalid", True, resolver, bound=10)
    client(image, options, selected, "http-cold-one-second.invalid", True, "req", bound=10, connect_timeout=1000)
    client(image, options, selected, "fixture-answer", True, "beam", bound=10)
    client(image, options, selected, "selected-libc.invalid", True, bound=10)
    same_process_recovery(image, selected)
    print("dns_selected_upstreams_regression=pass", flush=True)



if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    finally:
        cleanup()
