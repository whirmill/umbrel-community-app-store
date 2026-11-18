"""SatsSurge provisioning scripts run as umbrel without the docker group (#267).

The hermetic tests put a fake sudo and a fake docker first on PATH. The fake docker
refuses any call that sudo did not start, rejects every subcommand except a flagless
`exec lightning_lnd_1 ...` (so no `docker cp`, `-t` or `-i`), and emulates the LND
container: bakemacaroon writes a binary payload under its /tmp, cat streams it back,
rm deletes it, getinfo answers JSON.

RealDockerTest runs the same scripts against a real container named lightning_lnd_1
when SATSSURGE_PROVISION_REAL_DOCKER=1 (CI). It shows that `sudo docker exec ... cat`
without a tty returns exactly the bytes `docker cp` returns. With
SATSSURGE_PROVISION_REAL_SUDO=1 it uses the real sudo, otherwise a pass-through shim.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "whirmill-satssurge-autopilot" / "scripts"
TLS_CERT = "/home/umbrel/umbrel/app-data/lightning/data/lnd/tls.cert"
NODE_PUBKEY = "02" + "ab" * 32
BUSYBOX = "busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"

# Script -> the macaroons it bakes (credentials/<name>.macaroon from /tmp/satssurge-<name>.macaroon).
SCRIPTS = {
    "provision.sh": ["read", "write"],
    "provision-amboss.sh": ["amboss-sign", "amboss-backup"],
    "provision-channels.sh": ["channel"],
    "provision-loop.sh": ["loop"],
    "provision-lsp.sh": ["lsp"],
    "provision-node-sign.sh": ["node-sign"],
    "provision-sale.sh": ["sale"],
    "provision-swap.sh": ["swap"],
    "provision-swap-bump.sh": ["swap-bump"],
}
WITHOUT_URIS = {"write"}

FAKE_SUDO = """#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_LND_STATE/sudo.log"
[ "$1" = docker ] || { echo "fake sudo: only docker" >&2; exit 1; }
FAKE_SUDO=1 exec "$@"
"""

FAKE_DOCKER = """#!{python}
import json, os, sys
from pathlib import Path

state = Path(os.environ["FAKE_LND_STATE"])
args = sys.argv[1:]
sudo = os.environ.get("FAKE_SUDO") == "1"
with (state / "docker.log").open("a") as log:
    log.write(json.dumps({{"sudo": sudo, "argv": args}}) + "\\n")
if not sudo:
    sys.stderr.write("permission denied while trying to connect to the Docker daemon socket\\n")
    sys.exit(1)
if len(args) < 3 or args[:2] != ["exec", "lightning_lnd_1"]:
    sys.stderr.write("fake docker: unsupported call %r\\n" % args)
    sys.exit(2)


def inside(path):
    if not path.startswith("/tmp/") or "/../" in path:
        sys.stderr.write("fake docker: path outside /tmp: %s\\n" % path)
        sys.exit(2)
    return state / "lnd" / path[1:]


cmd = args[2:]
if cmd[:2] == ["lncli", "bakemacaroon"] and cmd[2].startswith("--save_to="):
    bakes = state / "bakes.jsonl"
    n = len(bakes.read_text().splitlines()) if bakes.exists() else 0
    # Every byte value, CR/LF, NUL, an escape sequence and trailing newlines: anything a
    # tty, a text mode or a command substitution would alter.
    payload = bytes(range(256)) + b"\\r\\n\\x00\\x1b[0m" + ("bake %d %s" % (n, " ".join(cmd[3:]))).encode() + b"\\n\\n"
    target = inside(cmd[2][len("--save_to="):])
    target.write_bytes(payload)
    with bakes.open("a") as log:
        log.write(json.dumps({{"path": cmd[2][len("--save_to="):], "uris": cmd[3:], "payload": payload.hex()}}) + "\\n")
elif cmd[0] == "cat" and len(cmd) == 2:
    sys.stdout.buffer.write(inside(cmd[1]).read_bytes())
elif cmd[0] == "rm" and len(cmd) == 2:
    inside(cmd[1]).unlink()
elif cmd == ["lncli", "getinfo"]:
    print(json.dumps({{"identity_pubkey": "{pubkey}", "alias": "fake"}}))
else:
    sys.stderr.write("fake docker: unsupported command %r\\n" % cmd)
    sys.exit(2)
"""


def write_executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


class FakeNode:
    """A temporary app directory, fake sudo and docker, and the fake container's /tmp."""

    def __init__(self, root):
        self.root = Path(root)
        self.state = self.root / "state"
        (self.state / "lnd" / "tmp").mkdir(parents=True)
        self.app = self.root / "app-data" / "whirmill-satssurge-autopilot"
        self.tls = self.root / "lnd" / "tls.cert"
        self.tls.parent.mkdir()
        self.tls.write_bytes(b"-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        write_executable(bin_dir / "sudo", FAKE_SUDO)
        write_executable(bin_dir / "docker", FAKE_DOCKER.format(python=sys.executable, pubkey=NODE_PUBKEY))
        self.env = {k: v for k, v in os.environ.items() if k != "FAKE_SUDO"}
        self.env.update(PATH=f"{bin_dir}{os.pathsep}{os.environ['PATH']}", FAKE_LND_STATE=str(self.state))
        self.scripts = self.root / "scripts"
        self.scripts.mkdir()
        for name in SCRIPTS:
            text = (SCRIPTS_DIR / name).read_text()
            if name == "provision.sh":
                # The only host path outside the app directory: the Lightning app's certificate.
                assert text.count(TLS_CERT) == 1
                text = text.replace(TLS_CERT, str(self.tls))
            (self.scripts / name).write_text(text)

    def run(self, script, check=True):
        result = subprocess.run(
            ["sh", str(self.scripts / script), str(self.app)],
            env=self.env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=60,
        )
        if check and result.returncode != 0:
            raise AssertionError(f"{script} exited {result.returncode}: {result.stderr.decode(errors='replace')}")
        return result

    def lines(self, name):
        path = self.state / name
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def credential(self, name):
        return self.app / "credentials" / f"{name}.macaroon"


class FakeDockerTest(unittest.TestCase):
    def node(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        return FakeNode(temp.name)

    def assert_private_and_mine(self, path):
        info = path.stat()
        self.assertEqual(info.st_uid, os.getuid(), path)
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600, path)

    def assert_every_docker_call_through_sudo(self, node):
        calls = node.lines("docker.log")
        self.assertTrue(calls)
        self.assertEqual([c["argv"] for c in calls if not c["sudo"]], [])
        self.assertEqual({c["argv"][0] for c in calls}, {"exec"})

    def test_fresh_bake_through_sudo_keeps_owner_mode_and_bytes(self):
        for script, names in SCRIPTS.items():
            with self.subTest(script=script):
                node = self.node()
                node.run(script)
                self.assert_every_docker_call_through_sudo(node)
                bakes = node.lines("bakes.jsonl")
                self.assertEqual([b["path"] for b in bakes], [f"/tmp/satssurge-{n}.macaroon" for n in names])
                for name, bake in zip(names, bakes):
                    cred = node.credential(name)
                    self.assertEqual(cred.read_bytes(), bytes.fromhex(bake["payload"]))
                    self.assert_private_and_mine(cred)
                    uris = Path(f"{cred}.uris")
                    if name in WITHOUT_URIS:
                        self.assertFalse(uris.exists())
                    else:
                        self.assertEqual(uris.read_text(), " ".join(bake["uris"]) + "\n")
                        self.assert_private_and_mine(uris)
                self.assertEqual(list((node.app / "credentials").glob("*.new")), [])
                self.assertEqual(list((node.state / "lnd" / "tmp").iterdir()), [])
                if script == "provision.sh":
                    for path in (node.app / "credentials").iterdir():
                        self.assert_private_and_mine(path)
                    self.assertEqual((node.app / "credentials" / "node-pubkey").read_text(), NODE_PUBKEY + "\n")
                    self.assertEqual((node.app / "credentials" / "tls.cert").read_bytes(), node.tls.read_bytes())

    def test_rerun_is_idempotent(self):
        for script, names in SCRIPTS.items():
            with self.subTest(script=script):
                node = self.node()
                node.run(script)
                before = {n: (node.credential(n).read_bytes(), node.credential(n).stat().st_ino) for n in names}
                calls = len(node.lines("docker.log"))
                node.run(script)
                self.assertEqual(len(node.lines("bakes.jsonl")), len(names))
                later = node.lines("docker.log")[calls:]
                # provision.sh reads the node pubkey on every run; nothing else touches LND again.
                expected = [["exec", "lightning_lnd_1", "lncli", "getinfo"]] if script == "provision.sh" else []
                self.assertEqual([c["argv"] for c in later], expected)
                self.assert_every_docker_call_through_sudo(node)
                for name in names:
                    cred = node.credential(name)
                    self.assertEqual((cred.read_bytes(), cred.stat().st_ino), before[name])
                    self.assert_private_and_mine(cred)

    def test_changed_uris_bakes_again(self):
        for script, names in SCRIPTS.items():
            name = next((n for n in names if n not in WITHOUT_URIS), None)
            with self.subTest(script=script, credential=name):
                node = self.node()
                node.run(script)
                cred = node.credential(name)
                old = cred.read_bytes()
                uris = Path(f"{cred}.uris")
                current = uris.read_text()
                uris.write_text("uri:/lnrpc.Lightning/GetInfo\n")
                node.run(script)
                bakes = node.lines("bakes.jsonl")
                self.assertEqual(len(bakes), len(names) + 1)
                self.assertEqual(bakes[-1]["path"], f"/tmp/satssurge-{name}.macaroon")
                self.assertEqual(cred.read_bytes(), bytes.fromhex(bakes[-1]["payload"]))
                self.assertNotEqual(cred.read_bytes(), old)
                self.assertEqual(uris.read_text(), current)
                self.assert_private_and_mine(cred)
                self.assert_private_and_mine(uris)
                self.assert_every_docker_call_through_sudo(node)
                self.assertEqual(list((node.app / "credentials").glob("*.new")), [])

    def test_harness_refuses_a_bare_docker_call(self):
        # The guard the tests above rely on: one docker call without sudo fails the script.
        node = self.node()
        script = node.scripts / "provision-node-sign.sh"
        text = script.read_text()
        self.assertEqual(text.count("  sudo docker exec lightning_lnd_1 rm "), 1)
        script.write_text(text.replace("  sudo docker exec lightning_lnd_1 rm ", "  docker exec lightning_lnd_1 rm "))
        result = node.run("provision-node-sign.sh", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"permission denied", result.stderr)
        self.assertEqual([c["argv"][2] for c in node.lines("docker.log") if not c["sudo"]], ["rm"])
        self.assertFalse(node.credential("node-sign").exists())


FAKE_LNCLI = """#!/bin/sh
case "$1" in
bakemacaroon) cp /payload.bin "${2#--save_to=}" ;;
getinfo) echo '{"identity_pubkey": "%s"}' ;;
*) exit 2 ;;
esac
""" % NODE_PUBKEY

SUDO_SHIM = """#!/bin/sh
[ "$1" = docker ] || exit 1
exec "$@"
"""


@unittest.skipUnless(os.environ.get("SATSSURGE_PROVISION_REAL_DOCKER") == "1", "set SATSSURGE_PROVISION_REAL_DOCKER=1")
class RealDockerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("docker") is None:
            raise unittest.SkipTest("docker is not installed")
        probe = subprocess.run(["docker", "inspect", "lightning_lnd_1"], capture_output=True)
        if probe.returncode == 0:
            raise unittest.SkipTest("a container named lightning_lnd_1 already exists here")
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        cls.payload = os.urandom(4096) + bytes(range(256)) + b"\r\n\x00\n\n"
        (root / "payload.bin").write_bytes(cls.payload)
        write_executable(root / "lncli", FAKE_LNCLI)
        docker = ["docker"]
        subprocess.run(
            docker + ["run", "-d", "--name", "lightning_lnd_1", "--network", "none", BUSYBOX, "sleep", "600"],
            check=True,
            capture_output=True,
        )
        try:
            subprocess.run(docker + ["cp", str(root / "payload.bin"), "lightning_lnd_1:/payload.bin"], check=True)
            subprocess.run(docker + ["cp", str(root / "lncli"), "lightning_lnd_1:/bin/lncli"], check=True)
            # The reference: what `docker cp` (the old fetch) gives for the same file.
            subprocess.run(docker + ["cp", "lightning_lnd_1:/payload.bin", str(root / "docker-cp.bin")], check=True)
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", "lightning_lnd_1"], capture_output=True)
        cls.temp.cleanup()

    def test_sudo_docker_exec_cat_matches_docker_cp(self):
        reference = (Path(self.temp.name) / "docker-cp.bin").read_bytes()
        self.assertEqual(reference, self.payload)
        for script, names in SCRIPTS.items():
            with self.subTest(script=script):
                temp = tempfile.TemporaryDirectory()
                self.addCleanup(temp.cleanup)
                node = FakeNode(temp.name)
                env = dict(os.environ)
                if os.environ.get("SATSSURGE_PROVISION_REAL_SUDO") != "1":
                    shim = Path(temp.name) / "shim"
                    shim.mkdir()
                    write_executable(shim / "sudo", SUDO_SHIM)
                    env["PATH"] = f"{shim}{os.pathsep}{env['PATH']}"
                result = subprocess.run(
                    ["sh", str(node.scripts / script), str(node.app)],
                    env=env,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    timeout=120,
                )
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                for name in names:
                    cred = node.credential(name)
                    self.assertEqual(cred.read_bytes(), reference)
                    info = cred.stat()
                    self.assertEqual(info.st_uid, os.getuid())
                    self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
                if script == "provision.sh":
                    self.assertEqual((node.app / "credentials" / "node-pubkey").read_text(), NODE_PUBKEY + "\n")


if __name__ == "__main__":
    unittest.main()
